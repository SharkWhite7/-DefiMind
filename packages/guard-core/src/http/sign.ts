import {
  csp,
  fromSignPage,
  maxDailyCap,
  pageHtml,
  rpcUrls,
  SIGN_PAGE_DIR,
  type SignPageConfig,
} from '@defimind/onchain/sign-page'
import { CHAINS, type ChainId } from '@defimind/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PublicKeys } from '../adapters/public-keys.js'

const SOLANA = new Map<ChainId, 'devnet' | 'mainnet-beta'>([
  [CHAINS.solanaDevnet, 'devnet'],
  [CHAINS.solanaMainnet, 'mainnet-beta'],
])
const EVM = new Map<ChainId, 'robinhood-testnet' | 'robinhood'>([
  [CHAINS.robinhoodTestnet, 'robinhood-testnet'],
  [CHAINS.robinhood, 'robinhood'],
])

const FILES = new Map([
  ['app.js', 'text/javascript; charset=utf-8'],
  ['style.css', 'text/css; charset=utf-8'],
])

export const DEFAULT_SIGN_DIR = SIGN_PAGE_DIR

/**
 * What this deployment's page acts for: its own hot wallets, and the public RPC of each cluster.
 * Never guard-core's own RPC: /sign is public, and that URL can carry the operator's API key.
 */
export function signConfig(keys: PublicKeys): SignPageConfig {
  const rpc = rpcUrls({})
  const config: SignPageConfig = { solana: {}, evm: {}, maxDailyCap: maxDailyCap({}) }
  for (const { chain, address } of keys.hotWallets) {
    const solana = SOLANA.get(chain)
    const evm = EVM.get(chain)
    if (solana !== undefined) {
      config.solana = { ...config.solana, [solana]: { rpc: rpc[solana] as string, hot: address } }
    }
    if (evm !== undefined) {
      config.evm = { ...config.evm, [evm]: { rpc: rpc[evm] as string, hot: address } }
    }
  }
  return config
}

/**
 * The signing page at /sign (CR-019), from onchain's build, with this deployment's hot wallets
 * filled in at serve time. A link never names the hot wallet, so a crafted one cannot make the page
 * grant an attacker's key (ADR 006).
 */
export function signRoutes(keys: PublicKeys, dir: string) {
  const page = fromSignPage(signConfig(keys))
  const policy = `${csp(page.rpc)}; frame-ancestors 'none'`

  function send(reply: FastifyReply, type: string, body: string | Buffer) {
    return reply
      .header('content-type', type)
      .header('content-security-policy', policy)
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-cache')
      .send(body)
  }

  const missing = (reply: FastifyReply) => reply.code(404).send({ error: 'sign_page_not_built' })

  return async (app: FastifyInstance) => {
    app.get('/sign', async (_request, reply) => reply.redirect('/sign/', 308))
    app.get('/sign/', async (_request, reply) => {
      const template = await readFile(join(dir, 'index.template.html'), 'utf8').catch(
        () => undefined,
      )
      return template === undefined
        ? missing(reply)
        : send(reply, 'text/html; charset=utf-8', pageHtml(template, page))
    })
    app.get('/sign/:file', async (request, reply) => {
      const { file } = request.params as { file: string }
      const type = FILES.get(file)
      const body =
        type === undefined ? undefined : await readFile(join(dir, file)).catch(() => undefined)
      return type === undefined || body === undefined ? missing(reply) : send(reply, type, body)
    })
  }
}
