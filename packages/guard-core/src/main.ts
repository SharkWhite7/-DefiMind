import { createSvmAnchor } from '@defimind/onchain'
import { readKeypairFile, readReceiptKeyFile } from './adapters/keypair.js'
import { withKeys } from './adapters/keystore.js'
import { publicKeys } from './adapters/public-keys.js'
import { readVapidKeyFile, webPushService } from './adapters/push.js'
import { buildChains } from './chains.js'
import { loadConfig } from './config.js'
import { migrateDb, openDb } from './db/client.js'
import { countPasskeys } from './db/passkeys.js'
import { requirePersistentDb } from './db/placement.js'
import { buildServers } from './http/server.js'
import { killTargets } from './kill-targets.js'

const env = loadConfig()

requirePersistentDb(env)

const config = await withKeys(env)

const db = openDb(config.DATABASE_URL)
migrateDb(db)

// Approvals above PASSKEY_ABOVE need a passkey; with none enrolled, nothing above it could ever be
// approved, and the owner would find out only when one was needed.
if (config.PASSKEY_ABOVE !== undefined && countPasskeys(db) === 0) {
  throw new Error('invalid configuration: PASSKEY_ABOVE is set but no passkey is enrolled')
}

const chains = await buildChains(config)
const receiptKey =
  config.RECEIPT_SIGNING_KEY_FILE === undefined
    ? undefined
    : await readReceiptKeyFile(config.RECEIPT_SIGNING_KEY_FILE)

const vapidSubject = config.VAPID_SUBJECT ?? config.PUBLIC_URL
const vapid =
  config.VAPID_PRIVATE_KEY_FILE === undefined || vapidSubject === undefined
    ? undefined
    : await readVapidKeyFile(config.VAPID_PRIVATE_KEY_FILE, vapidSubject)

// The anchor key is its own keypair: one that holds fees only, so a leak of it moves no funds.
const anchorPublisher =
  config.ANCHOR_CHAIN === undefined ||
  config.ANCHOR_RPC_URL === undefined ||
  config.ANCHOR_KEY_FILE === undefined
    ? undefined
    : createSvmAnchor({
        chain: config.ANCHOR_CHAIN,
        rpcUrl: config.ANCHOR_RPC_URL,
        secretKey: await readKeypairFile(config.ANCHOR_KEY_FILE),
      })

const targets = config.SIGN_PAGE_URL === undefined ? [] : await killTargets(config)

const keys = await publicKeys(config)
const split = config.PUBLIC_PORT !== undefined
const [app, publicApp] = await buildServers(
  {
    db,
    config,
    chains,
    sweepMs: config.EXPIRY_SWEEP_MS,
    killTargets: targets,
    keys,
    ...(anchorPublisher === undefined ? {} : { anchorPublisher }),
    ...(vapid === undefined
      ? {}
      : { push: { service: webPushService(vapid), publicKey: vapid.publicKey } }),
    ...(receiptKey === undefined ? {} : { receiptKey }),
  },
  split ? (['private', 'public'] as const) : (['all'] as const),
)

if (config.GUARD_STUB_CHAINS === 'true') {
  app.log.warn('stub chains: nothing is signed and no money moves')
} else if (chains.size === 0) {
  // With no adapter the policy has no chain to clear a payment on, so every payment is refused:
  // default deny, not a degraded mode.
  app.log.warn('no chain adapter configured: every payment will be refused')
}
for (const { chain } of keys.hotWallets) {
  if (!chains.has(chain)) {
    app.log.info({ chain }, 'no vault yet: the chain waits for the owner to adopt one in the panel')
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void Promise.all([app.close(), publicApp?.close()])
  })
}

await app.listen({ port: config.PORT, host: config.HOST })
if (publicApp !== undefined) {
  await publicApp.listen({ port: config.PUBLIC_PORT, host: config.PUBLIC_HOST })
}
