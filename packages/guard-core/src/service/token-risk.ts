import type { TokenRisk } from '@defimind/shared'
import type { TokenSearch } from '../adapters/jupiter-tokens.js'
import { everHeld } from '../db/trades.js'
import { HttpError } from '../http/errors.js'
import type { PaymentDeps } from './payments.js'
import { VenueUnavailable } from './swap-quote.js'

/** A token's mint facts (CR-025), with the venue's own claims labelled as such. */
export async function tokenRisk(
  deps: PaymentDeps,
  search: TokenSearch,
  chain: string,
  mint: string,
): Promise<TokenRisk> {
  const adapter = deps.chains.get(chain)
  if (adapter?.tokenRisk === undefined) {
    throw new HttpError(400, 'not_tradable')
  }
  const facts = await adapter.tokenRisk(mint).catch(() => {
    throw new VenueUnavailable()
  })
  // A venue that is down leaves its claims out; the mint facts stand on their own.
  const listed = await search(chain, mint).catch(() => [])
  const token = listed.find((t) => t.mint === mint)
  return {
    ...facts,
    flags: [
      ...(everHeld(deps.db, chain, mint) ? [] : (['NEW_TOKEN'] as const)),
      ...(facts.mintAuthority ? (['MINT_AUTHORITY'] as const) : []),
    ],
    venue: { verified: token?.verified ?? false, ...token?.venue },
  }
}
