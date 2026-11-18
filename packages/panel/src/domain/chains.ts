import { CHAINS } from '@defimind/shared'

const NAMES = new Map<string, string>([
  [CHAINS.solanaMainnet, 'Solana'],
  [CHAINS.solanaDevnet, 'Solana devnet'],
  [CHAINS.base, 'Base'],
  [CHAINS.baseSepolia, 'Base Sepolia'],
  [CHAINS.robinhood, 'Robinhood Chain'],
  [CHAINS.robinhoodTestnet, 'Robinhood Chain testnet'],
])

/** A chain the panel does not know is shown by its id, never guessed. */
export function chainName(chain: string): string {
  return NAMES.get(chain) ?? chain
}
