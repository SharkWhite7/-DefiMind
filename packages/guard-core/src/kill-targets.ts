import type { KillTarget } from '@defimind/shared'
import { privateKeyToAddress } from 'viem/accounts'
import { readEvmKeyFile, readKeypairFile } from './adapters/keypair.js'
import type { Config } from './config.js'
import { base58 } from './domain/base58.js'

/**
 * The chains whose onchain kill the signing page can build (CR-014), from guard-core's own
 * config: the vault and the hot wallet on each family, the Squads multisig on Solana and the Safe on
 * Robinhood Chain. The hosted page knows no hot wallet of its own, so the link names it (CR-020).
 * Every value is public; the page checks the chain before it asks for a signature.
 */
export async function killTargets(config: Config): Promise<KillTarget[]> {
  const targets: KillTarget[] = []
  if (config.SQUADS_MULTISIG !== undefined && config.SOLANA_HOT_WALLET_KEYPAIR !== undefined) {
    // A Solana keypair file holds the secret key, then the public key: the last 32 bytes.
    const secret = await readKeypairFile(config.SOLANA_HOT_WALLET_KEYPAIR)
    const hot = base58(secret.slice(32))
    targets.push({ chain: config.SOLANA_CHAIN, multisig: config.SQUADS_MULTISIG, hot })
  }
  const { ROBINHOOD_CHAIN: chain, ROBINHOOD_SAFE_ADDRESS: safe } = config
  if (
    chain !== undefined &&
    safe !== undefined &&
    config.ROBINHOOD_HOT_WALLET_KEY_FILE !== undefined
  ) {
    const hot = privateKeyToAddress(await readEvmKeyFile(config.ROBINHOOD_HOT_WALLET_KEY_FILE))
    targets.push({ chain, safe, hot })
  }
  return targets
}
