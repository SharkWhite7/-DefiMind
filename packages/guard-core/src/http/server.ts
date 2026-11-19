import type { ChainAdapter } from '@defimind/onchain'
import type { ChainId, KillTarget } from '@defimind/shared'
import rateLimit from '@fastify/rate-limit'
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import type { KeyObject } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { httpBotNotifier, type BotNotifier } from '../adapters/bot.js'
import type { Config } from '../config.js'
import type { Db } from '../db/client.js'
import { usdcFor } from '../chains.js'
import { parseBearer, tokenMatches } from '../domain/auth.js'
import { serializeError } from '../domain/redact.js'
import type { PasskeySetup } from '../service/passkeys.js'
import { publicKeyHex } from '../service/receipts.js'
import { serial } from '../service/serial.js'
import type { X402Deps } from '../service/x402.js'
import { adminRoutes } from './admin.js'
import { agentRoutes } from './agent.js'
import { botRoutes } from './bot.js'
import { ownerRoutes } from './owner.js'
import { ownerPanelRoutes } from './owner-panel.js'
import { DEFAULT_PANEL_DIR, panelRoutes } from './panel.js'
import { publicAnchors } from './executions.js'
import type { PushService } from '../adapters/push.js'
import { pusher } from '../service/push.js'
import { integrityMonitor } from '../service/integrity.js'
import type { AnchorPublisher } from '../service/anchor.js'
import { startTimers } from './timers.js'
import { ownerSessionRoutes } from './owner-session.js'

declare module 'fastify' {
  interface FastifyRequest {
    agentId?: string
  }
}

export interface ServerDeps {
  db: Db
  config: Config
  chains?: ReadonlyMap<ChainId, ChainAdapter>
  bot?: BotNotifier
  fetch?: typeof fetch
  now?: () => Date
  /** Runs the expiry sweep on this interval. Off when unset, as in tests that drive it directly. */
  sweepMs?: number
  /** Signs receipts. Receipts are off without it. */
  receiptKey?: KeyObject
  /** Web Push to the owner's panel, with the VAPID public key the panel subscribes with. */
  push?: { service: PushService; publicKey: string }
  /** Publishes receipt anchors (CR-013); anchoring is off without it. */
  anchorPublisher?: AnchorPublisher
  /** The chains the owner kill links to the signing page for, with SIGN_PAGE_URL (CR-014). */
  killTargets?: KillTarget[]
}

/**
 * Which routes a listener serves. `all` is the one listener of a local run. A deployment splits
 * them: `public` faces the internet behind Fly's TLS and serves only the agent routes, `private`
 * sits on Fly's private network and serves the admin and bot routes to the bot.
 */
export type Surface = 'all' | 'public' | 'private'

/** Every route on one listener, as a local run and the tests use it. */
export async function buildServer(options: ServerDeps): Promise<Server> {
  const [app] = await buildServers(options, ['all'])
  return app
}

/**
 * One app per surface over one set of deps. They must share them: the bot's approval on the
 * private listener and the agent's request on the public one take the same per-agent lock.
 */
export async function buildServers(
  options: ServerDeps,
  surfaces: readonly [Surface, ...Surface[]],
): Promise<[Server, ...Server[]]> {
  const { config } = options
  const apps: Server[] = surfaces.map(() =>
    Fastify({
      logger: {
        level: config.LOG_LEVEL,
        // A bearer token in a log file is the same as a bearer token in a repository.
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-guard-signature"]',
          'res.headers["set-cookie"]',
        ],
        serializers: { err: serializeError },
      },
    }),
  )
  const [first] = apps as [Server, ...Server[]]
  const deps = paymentDeps(options, first.log)
  if (deps.receiptKey !== undefined) {
    deps.integrity = integrityMonitor(deps, deps.receiptKey)
  }
  for (const [i, surface] of surfaces.entries()) {
    await serve(
      apps[i] as Server,
      surface,
      deps,
      config,
      options.killTargets ?? [],
      options.push?.publicKey,
    )
  }

  startTimers(first, deps, options)
  return apps as [Server, ...Server[]]
}

function passkeySetup(config: Config): { passkey: PasskeySetup } | undefined {
  const { PASSKEY_ABOVE: above, PASSKEY_RP_ID: rpId, PASSKEY_ORIGIN: origin } = config
  return above === undefined || rpId === undefined || origin === undefined
    ? undefined
    : { passkey: { above, rpId, origin } }
}

function paymentDeps(options: ServerDeps, log: FastifyBaseLogger): X402Deps {
  const chains = options.chains ?? new Map<ChainId, ChainAdapter>()
  const usdc = new Map<ChainId, string>()
  for (const chain of chains.keys()) {
    const address = usdcFor(options.config, chain)
    if (address !== undefined) {
      usdc.set(chain, address)
    }
  }
  return {
    db: options.db,
    chains,
    usdc,
    bot: options.bot ?? httpBotNotifier(options.config),
    fetch: options.fetch ?? fetch,
    now: options.now ?? (() => new Date()),
    serial: serial(),
    log,
    ...(options.receiptKey === undefined ? {} : { receiptKey: options.receiptKey }),
    ...(passkeySetup(options.config) ?? {}),
    ...(options.push === undefined
      ? {}
      : {
          push: pusher({
            db: options.db,
            service: options.push.service,
            now: options.now ?? (() => new Date()),
            log,
          }),
        }),
  }
}

/**
 * Behind Fly's proxy every request comes from the proxy, so the per-IP limit would be one limit
 * for the whole internet. Fly sets Fly-Client-IP to the real address. Only the public listener
 * sits behind that proxy, so only there is the header believed.
 */
function clientIp(surface: Surface, trustFly: boolean): (request: FastifyRequest) => string {
  if (surface !== 'public' || !trustFly) {
    return (request) => request.ip
  }
  return (request) => {
    const header = request.headers['fly-client-ip']
    return typeof header === 'string' && isIP(header) !== 0 ? header : request.ip
  }
}

async function serve(
  app: FastifyInstance,
  surface: Surface,
  deps: X402Deps,
  config: Config,
  killTargets: KillTarget[],
  pushKey: string | undefined,
) {
  const ipOf = clientIp(surface, config.TRUST_FLY_CLIENT_IP === 'true')
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_IP,
    timeWindow: '1 minute',
    keyGenerator: ipOf,
  })

  app.setErrorHandler((error: FastifyError | z.ZodError, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request', issues: issuesOf(error) })
    }
    if (error.statusCode !== undefined && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message })
    }
    request.log.error({ err: error }, 'unhandled error')
    return reply.code(500).send({ error: 'internal_error' })
  })

  function requireToken(expected: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const presented = parseBearer(request.headers.authorization)
      if (presented === undefined || !tokenMatches(presented, expected)) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
    }
  }

  if (surface !== 'private') {
    // The owner's passkey page faces the internet: it is opened from Telegram on any device.
    const rp =
      config.PASSKEY_RP_ID === undefined || config.PASSKEY_ORIGIN === undefined
        ? undefined
        : { rpId: config.PASSKEY_RP_ID, origin: config.PASSKEY_ORIGIN }
    app.register(ownerRoutes(deps, rp))
    app.register(panelRoutes(config.PANEL_DIR ?? DEFAULT_PANEL_DIR))
    if (rp !== undefined) {
      app.register(
        ownerSessionRoutes(
          deps,
          rp,
          ownerPanelRoutes(deps, rp, {
            botUrl: config.BOT_URL,
            databaseUrl: config.DATABASE_URL,
            ...(pushKey === undefined ? {} : { pushKey }),
            ...(config.SIGN_PAGE_URL === undefined
              ? {}
              : { signing: { page: config.SIGN_PAGE_URL, targets: killTargets } }),
          }),
        ),
      )
    }
    app.register(
      agentRoutes(deps, {
        perIp: config.RATE_LIMIT_PER_IP,
        perAgent: config.RATE_LIMIT_PER_AGENT,
        ipOf,
      }),
      { prefix: '/v1/agent' },
    )
  }
  if (surface !== 'public') {
    app.register(
      async (admin) => {
        admin.addHook('preHandler', requireToken(config.ADMIN_TOKEN))
        await admin.register(
          adminRoutes(deps, {
            botUrl: config.BOT_URL,
            databaseUrl: config.DATABASE_URL,
            ...(config.PASSKEY_RP_ID === undefined ? {} : { passkeyRpId: config.PASSKEY_RP_ID }),
            ...(config.PASSKEY_ORIGIN === undefined
              ? {}
              : { passkeyOrigin: config.PASSKEY_ORIGIN }),
          }),
        )
      },
      { prefix: '/v1/admin' },
    )
    app.register(
      async (bot) => {
        bot.addHook('preHandler', requireToken(config.BOT_TOKEN))
        await bot.register(
          botRoutes(deps, config.TELEGRAM_APPROVALS === 'true', {
            botUrl: config.BOT_URL,
            databaseUrl: config.DATABASE_URL,
          }),
        )
      },
      { prefix: '/v1/bot' },
    )
  }

  app.get('/health', async () => ({ status: 'ok' }))

  if (surface !== 'private') {
    await app.register(publicAnchors(deps))
  }

  // Public on purpose: anyone holding a receipt can check it without trusting this server.
  app.get('/v1/receipts/key', async (_request, reply) =>
    deps.receiptKey === undefined
      ? reply.code(404).send({ error: 'not_configured' })
      : { publicKey: publicKeyHex(deps.receiptKey) },
  )
}

function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}

export type Server = FastifyInstance
