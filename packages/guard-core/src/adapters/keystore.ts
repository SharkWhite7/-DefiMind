import { CHAINS, type ChainId } from '@defimind/shared'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { generatePrivateKey } from 'viem/accounts'
import type { Config } from '../config.js'
import { dbFile } from '../db/client.js'

type Kind = 'solana' | 'evm' | 'ed25519' | 'p256'

/** Each kind in the format its reader in keypair.ts or push.ts already takes. */
const make: Record<Kind, () => string> = {
  solana: () => JSON.stringify(solanaKeypair()),
  evm: () => generatePrivateKey(),
  ed25519: () => pem(generateKeyPairSync('ed25519').privateKey),
  p256: () => pem(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey),
}

function pem(key: KeyObject): string {
  return key.export({ format: 'pem', type: 'pkcs8' }).toString()
}

/** The Solana CLI layout: the 32-byte seed, then the 32-byte public key. */
function solanaKeypair(): number[] {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url')
  return [...seed, ...pub]
}

/** Next to the database: the one place a deployment already keeps on a persistent disk. */
export function keysDir(config: Config): string {
  const file = dbFile(config.DATABASE_URL)
  return config.KEYS_DIR ?? join(file === ':memory:' ? './data' : dirname(file), 'keys')
}

/**
 * The key file at dir/name, made once. `wx` never replaces a file that exists: a second start, or
 * two at once, keeps the first key, since a new hot wallet would no longer match its onchain limit.
 */
export async function ensureKey(dir: string, name: string, kind: Kind): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const path = join(dir, name)
  try {
    await writeFile(path, make[kind](), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
  await chmod(path, 0o600)
  return path
}

function slug(chain: ChainId): string {
  const name = Object.entries(CHAINS).find(([, id]) => id === chain)?.[0] ?? chain
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/[^a-z0-9-]/g, '-')
}

/**
 * The config with every key file it lacks made under `dir` (CR-019). A key given by env or a file
 * always wins, so a deployment that passes its keys as secrets is unchanged.
 */
export async function withKeys(config: Config, dir = keysDir(config)): Promise<Config> {
  const key = (given: string | undefined, name: string, kind: Kind) =>
    given === undefined ? ensureKey(dir, name, kind) : Promise.resolve(given)
  const evm = (chain: ChainId | undefined, given: string | undefined) =>
    chain === undefined ? Promise.resolve(given) : key(given, `hot-${slug(chain)}`, 'evm')
  const solana = config.SOLANA_CHAIN
  return {
    ...config,
    SOLANA_HOT_WALLET_KEYPAIR: await key(
      config.SOLANA_HOT_WALLET_KEYPAIR,
      `hot-${slug(solana)}.json`,
      'solana',
    ),
    BASE_HOT_WALLET_KEY_FILE: await evm(config.BASE_CHAIN, config.BASE_HOT_WALLET_KEY_FILE),
    ROBINHOOD_HOT_WALLET_KEY_FILE: await evm(
      config.ROBINHOOD_CHAIN,
      config.ROBINHOOD_HOT_WALLET_KEY_FILE,
    ),
    RECEIPT_SIGNING_KEY_FILE: await key(config.RECEIPT_SIGNING_KEY_FILE, 'receipt.pem', 'ed25519'),
    VAPID_PRIVATE_KEY_FILE: await key(config.VAPID_PRIVATE_KEY_FILE, 'vapid.pem', 'p256'),
    ANCHOR_KEY_FILE: await key(config.ANCHOR_KEY_FILE, 'anchor.json', 'solana'),
  }
}
