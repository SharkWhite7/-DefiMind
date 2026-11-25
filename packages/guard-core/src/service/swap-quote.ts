import { type ChainAdapter, SwapUnavailable } from '@defimind/onchain'
import type { PayIntent, SwapDetails, SwapQuote } from '@defimind/shared'
import { z } from 'zod'
import type { Trade } from '../domain/trading.js'
import { belowGasReserve, swapValue, WSOL } from '../domain/valuation.js'
import type { QuoteRequest } from '../http/schemas.js'
import type { PaymentDeps } from './payments.js'

/** Read from the mints onchain by the adapter; a quote without them is not one we can record. */
const mints = z.object({
  decimalsIn: z.number().int().min(0).max(255),
  decimalsOut: z.number().int().min(0).max(255),
  symbolIn: z.string().max(32).optional(),
  symbolOut: z.string().max(32).optional(),
})

/** `spends` is the token a sell or a swap gives up; `token` the one a buy or swap brings in. */
export type Pair = Pick<Trade, 'side' | 'token'> & { spends: string }

/** A buy or a sell has the chain's dollar on one side; a swap (CR-026) has it on neither. */
export function pairOf(deps: PaymentDeps, req: QuoteRequest): Pair | undefined {
  const dollar = deps.usdc.get(req.chain)
  if (dollar === undefined || req.tokenIn === req.tokenOut) {
    return undefined
  }
  if (req.tokenIn === dollar) {
    return { side: 'buy', token: req.tokenOut, spends: dollar }
  }
  if (req.tokenOut === dollar) {
    return { side: 'sell', token: req.tokenIn, spends: req.tokenIn }
  }
  return { side: 'swap', token: req.tokenOut, spends: req.tokenIn }
}

/** The chain's dollar; a swap is priced only on a chain that has one, as pairOf already checked. */
export const dollarOf = (deps: PaymentDeps, chain: string) => deps.usdc.get(chain) ?? ''

/** The venue is down or answered nonsense: the route says 502, as for an upstream x402 API. */
export class VenueUnavailable extends Error {
  constructor() {
    super('venue_unavailable')
  }
}

/** The venue's quote, or 'no_route'. A venue that is down is not a rejection of the trade. */
export async function fetchQuote(
  adapter: ChainAdapter,
  req: QuoteRequest,
  slippageBps: number,
): Promise<SwapQuote | 'no_route'> {
  if (adapter.quoteSwap === undefined) {
    return 'no_route'
  }
  try {
    const { tokenIn, tokenOut, amountIn } = req
    return await adapter.quoteSwap({ tokenIn, tokenOut, amountIn, slippageBps })
  } catch (error) {
    if (error instanceof SwapUnavailable && error.code === 'no_route') {
      return 'no_route'
    }
    throw new VenueUnavailable()
  }
}

/** The intent with the quote's terms, or undefined when the quote lacks the mints' decimals. */
export function withQuote(
  intent: PayIntent,
  quote: SwapQuote,
  tokenOut: string,
): PayIntent | undefined {
  const decimals = mints.safeParse(quote)
  if (!decimals.success) {
    return undefined
  }
  const { venue, expectedOut, minAmountOut, slippageBps, priceImpactBps, quotedAt } = quote
  // A sell counts at expectedOut (CR-026).
  const swap: SwapDetails = {
    venue,
    tokenOut,
    expectedOut,
    minAmountOut,
    slippageBps,
    priceImpactBps,
    quotedAt,
    ...decimals.data,
  }
  return { ...intent, swap }
}

/**
 * A swap's worth in the chain's dollar (CR-026): both legs quoted back to it through the adapter.
 * A leg with no route leaves the swap unvalued, which refuses it; a venue that is down throws.
 */
export async function valueOf(
  adapter: ChainAdapter,
  legs: { token: string; amount: string }[],
  maxImpactBps: number,
  now: Date,
): Promise<bigint | undefined> {
  const quoteSell = adapter.quoteSell?.bind(adapter)
  if (quoteSell === undefined) {
    return undefined
  }
  try {
    const quoted = await Promise.all(legs.map((leg) => quoteSell(leg.token, leg.amount)))
    return swapValue(quoted, maxImpactBps, now)
  } catch (error) {
    if (error instanceof SwapUnavailable && error.code === 'no_route') {
      return undefined
    }
    throw new VenueUnavailable()
  }
}

/**
 * GAS_RESERVE when the trade would leave the hot wallet unable to pay for the next sell (CR-026).
 * A balance that cannot be read refuses too. A sell of a token to the dollar is exempt (SPEC
 * v0.21): it is how Close and the stop-losses get out, and costs SOL only for its fee. A sell of SOL
 * itself spends SOL, so it meets the reserve like a buy.
 */
export async function gasReason(
  adapter: ChainAdapter,
  req: { tokenIn: string; amountIn: string },
  side: Trade['side'],
): Promise<'GAS_RESERVE' | undefined> {
  if (side === 'sell' && req.tokenIn !== WSOL) {
    return undefined
  }
  const gas = await adapter.getHotWalletGas().catch(() => undefined)
  return gas === undefined || belowGasReserve(gas, req.tokenIn, req.amountIn)
    ? 'GAS_RESERVE'
    : undefined
}

/** A swap's two legs back to the dollar: what it gives up, and the least it brings in. */
export const swapLegs = (
  req: { tokenIn: string; amountIn: string; tokenOut: string },
  minAmountOut: string,
) => [
  { token: req.tokenIn, amount: req.amountIn },
  { token: req.tokenOut, amount: minAmountOut },
]
