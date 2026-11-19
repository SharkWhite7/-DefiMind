import { CHAINS } from '@defimind/shared'
import { z } from 'zod'

const secret = z.string().min(32, 'use at least 32 characters; generate with openssl rand -hex 32')

// `KEY=` in a .env file means unset, as the .env.example files leave it.
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional())
}

const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x address')

export const configSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8787),
    /** Loopback unless set: a deployment opts in to listening beyond this machine. */
    HOST: z.union([z.ipv4(), z.ipv6(), z.hostname()]).default('127.0.0.1'),
    /**
     * Set in a deployment to split the routes over two listeners: the agent routes alone on
     * PUBLIC_HOST:PUBLIC_PORT, behind Fly's TLS, and the admin and bot routes on HOST:PORT, on the
     * private network. Unset, one listener on HOST:PORT serves everything, as in a local run.
     */
    PUBLIC_PORT: optional(z.coerce.number().int().positive()),
    PUBLIC_HOST: z.union([z.ipv4(), z.ipv6(), z.hostname()]).default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1).default('file:./data/guard.db'),

    ADMIN_TOKEN: secret,
    BOT_TOKEN: secret,

    BOT_URL: z.string().min(1),
    BOT_WEBHOOK_SECRET: secret,

    SOLANA_CHAIN: z.enum([CHAINS.solanaDevnet, CHAINS.solanaMainnet]).default(CHAINS.solanaDevnet),
    SOLANA_RPC_URL: optional(z.string().min(1)),
    SOLANA_HOT_WALLET_KEYPAIR: optional(z.string().min(1)),
    SQUADS_MULTISIG: optional(z.string().min(1)),

    /** Base is off unless this names the chain; then every value below must be present. */
    BASE_CHAIN: optional(z.enum([CHAINS.baseSepolia, CHAINS.base])),
    BASE_RPC_URL: optional(z.url()),
    SAFE_ADDRESS: optional(evmAddress),
    /** Path to a file holding the hot wallet's private key, 0x and 64 hex digits. */
    BASE_HOT_WALLET_KEY_FILE: optional(z.string().min(1)),
    // The raw key in the environment is retired. Refused rather than ignored, so an old .env
    // has to lose the key instead of keeping a copy nobody reads.
    HOT_WALLET_PRIVATE_KEY: optional(z.never()),
    /** Only where shared/addresses.ts has no verified value for the chain yet (CR-005). */
    BASE_USDC: optional(evmAddress),
    BASE_ALLOWANCE_MODULE: optional(evmAddress),

    /**
     * Robinhood Chain is off unless this names it (CR-007). Its USDG and Allowance Module come from
     * shared/addresses.ts only, so there is no env value for either.
     */
    ROBINHOOD_CHAIN: optional(z.enum([CHAINS.robinhoodTestnet, CHAINS.robinhood])),
    ROBINHOOD_RPC_URL: optional(z.url()),
    ROBINHOOD_SAFE_ADDRESS: optional(evmAddress),
    /** Path to a file holding the hot wallet's private key, 0x and 64 hex digits. */
    ROBINHOOD_HOT_WALLET_KEY_FILE: optional(z.string().min(1)),

    /** An Ed25519 private key in PEM that signs a receipt for every executed payment. Off unset. */
    RECEIPT_SIGNING_KEY_FILE: optional(z.string().min(1)),

    /**
     * At or above this amount an intent is approved only with the owner's passkey, never by a
     * Telegram tap alone. PASSKEY_RP_ID and PASSKEY_ORIGIN name guard-core's public address, which
     * the passkey is bound to. Off unset.
     */
    PASSKEY_ABOVE: optional(z.string().regex(/^(0|[1-9]\d*)$/)),
    PASSKEY_RP_ID: optional(z.hostname()),
    PASSKEY_ORIGIN: optional(z.url({ protocol: /^https$/ })),

    /**
     * CR-012. When false, the default, the panel is the only place to approve: a Telegram tap can
     * still reject, never approve, so a stolen Telegram account moves nothing.
     */
    TELEGRAM_APPROVALS: z.enum(['true', 'false']).default('false'),
    /**
     * CR-012. Web Push to the owner's panel: a P-256 private key in PEM, and the contact the push
     * services may reach (mailto: or https:). Both or neither; push is off without them.
     */
    VAPID_PRIVATE_KEY_FILE: optional(z.string().min(1)),
    VAPID_SUBJECT: optional(z.string().regex(/^(mailto:|https:\/\/)\S+$/)),
    /**
     * CR-013. Anchoring of the execution chain: a Solana cluster, its RPC, and a keypair of its own,
     * funded for fees only and never the hot wallet. All three or none; off without them.
     */
    ANCHOR_CHAIN: optional(z.enum([CHAINS.solanaDevnet, CHAINS.solanaMainnet])),
    ANCHOR_RPC_URL: optional(z.url({ protocol: /^https?$/ })),
    ANCHOR_KEY_FILE: optional(z.string().min(1)),
    /** CR-014. The onchain signing page; with it, the owner kill links each chain's kill there. */
    SIGN_PAGE_URL: optional(z.url({ protocol: /^https$/ })),
    /** The panel's static build, served at /panel. Defaults to packages/panel/dist. */
    PANEL_DIR: optional(z.string().min(1)),

    /** Offline chains that move no money. For local development only. */
    GUARD_STUB_CHAINS: z.enum(['true', 'false']).default('false'),
    EXPIRY_SWEEP_MS: z.coerce.number().int().positive().default(30_000),

    /**
     * Whether the public listener may read the client's address from Fly-Client-IP. Only behind a
     * proxy that sets it and drops the client's own (Fly, or the Caddy in deploy/): anywhere else a
     * client picks a fresh one per request and is never limited.
     */
    TRUST_FLY_CLIENT_IP: z.enum(['true', 'false']).default('false'),

    /** Requests per minute. Per IP on every route, and per agent token on the agent routes. */
    RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(120),
    RATE_LIMIT_PER_AGENT: z.coerce.number().int().positive().default(60),
  })
  // A passkey is bound to an origin and an RP id, and a browser accepts the pair only when the
  // origin is exactly scheme://host[:port] and its host is the RP id or under it. A mismatch would
  // pass startup and then refuse every enrolment and approval.
  .refine(
    (c) => c.PASSKEY_ORIGIN === undefined || originMatches(c.PASSKEY_ORIGIN, c.PASSKEY_RP_ID),
    {
      path: ['PASSKEY_ORIGIN'],
    },
  )
  .refine(
    (c) =>
      [c.ANCHOR_CHAIN, c.ANCHOR_RPC_URL, c.ANCHOR_KEY_FILE].every((v) => v === undefined) ||
      [c.ANCHOR_CHAIN, c.ANCHOR_RPC_URL, c.ANCHOR_KEY_FILE, c.RECEIPT_SIGNING_KEY_FILE].every(
        (v) => v !== undefined,
      ),
    // Anchoring roots over receipts that are never signed would prove nothing.
    {
      path: ['ANCHOR_CHAIN'],
      message: 'needs ANCHOR_RPC_URL, ANCHOR_KEY_FILE and RECEIPT_SIGNING_KEY_FILE',
    },
  )
  .refine((c) => (c.VAPID_PRIVATE_KEY_FILE === undefined) === (c.VAPID_SUBJECT === undefined), {
    path: ['VAPID_SUBJECT'],
  })
  // A passkey is bound to an address, so turning them on without one would approve nothing.
  .refine(
    (c) =>
      c.PASSKEY_ABOVE === undefined ||
      (c.PASSKEY_RP_ID !== undefined && c.PASSKEY_ORIGIN !== undefined),
    { path: ['PASSKEY_RP_ID'] },
  )

function originMatches(origin: string, rpId: string | undefined): boolean {
  const url = new URL(origin)
  return (
    url.origin === origin &&
    rpId !== undefined &&
    (url.hostname === rpId || url.hostname.endsWith(`.${rpId}`))
  )
}

export type Config = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env)
  if (!parsed.success) {
    // Names only. The values are secrets and this runs at startup, often into a shared log.
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
    throw new Error(`invalid configuration: ${fields}`)
  }
  return parsed.data
}
