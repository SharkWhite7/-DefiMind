import type { Amount } from '@defimind/shared'
import { parseAmount } from './amount.js'
import { QUOTE_MAX_AGE_MS } from './trading.js'

/** The venue's price of selling one leg back to the chain's dollar (ChainAdapter.quoteSell). */
export interface Leg {
  out: Amount
  priceImpactBps: number
  quotedAt: string
}

/**
 * A token-to-token swap's worth for the limits (CR-026): the higher of its two legs priced back
 * to the dollar, so a leg the venue prices low cannot carry a trade past a limit. Undefined when
 * either leg is stale or moves the price beyond `maxImpactBps`.
 */
export function swapValue(legs: Leg[], maxImpactBps: number, now: Date): bigint | undefined {
  const fresh = (leg: Leg) => {
    const age = now.getTime() - Date.parse(leg.quotedAt)
    return age >= 0 && age <= QUOTE_MAX_AGE_MS
  }
  if (legs.length === 0 || legs.some((leg) => !fresh(leg) || leg.priceImpactBps > maxImpactBps)) {
    return undefined
  }
  return legs.reduce((high, leg) => {
    const out = parseAmount(leg.out)
    return out > high ? out : high
  }, 0n)
}

/** Wrapped SOL, the one mint whose leg is the hot wallet's own fee coin. */
export const WSOL = 'So11111111111111111111111111111111111111112'

/**
 * Whether a trade would leave the hot wallet's SOL below what the next sell needs in fees
 * (GAS_RESERVE). Spending SOL itself counts against it.
 */
export function belowGasReserve(
  gas: { balance: Amount; minimum: Amount },
  tokenIn: string,
  amountIn: Amount,
): boolean {
  const spent = tokenIn === WSOL ? parseAmount(amountIn) : 0n
  return parseAmount(gas.balance) - spent < parseAmount(gas.minimum)
}
