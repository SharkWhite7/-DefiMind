import { parseUsd } from './usd.js'

export interface SwapRequest {
  from: string
  to: string
  amountUsd?: string
  amount?: string
}

export type ResolvedSwap =
  | { ok: true; side: 'buy' | 'sell'; tokenIn: string; tokenOut: string; amountIn: bigint }
  | { ok: false; error: string }

const DOLLAR_ALIASES = /^(usd|usdc|usdg|\$)$/i
const ATOMIC = /^[1-9]\d{0,39}$/

/**
 * Phase 1 of trading always has the chain's dollar on one side: a buy spends it, a sell returns to
 * it. So the side follows from the tokens, and so does which amount field is meaningful.
 */
export function resolveSwap(request: SwapRequest, dollar: string): ResolvedSwap {
  const isDollar = (token: string) => DOLLAR_ALIASES.test(token) || token === dollar
  const fromDollar = isDollar(request.from)
  const toDollar = isDollar(request.to)
  if (fromDollar === toDollar) {
    return {
      ok: false,
      error:
        "One side of a swap must be the chain's dollar and the other a token: a buy spends dollars, a sell returns to them.",
    }
  }
  if ((request.amountUsd === undefined) === (request.amount === undefined)) {
    return { ok: false, error: 'Give exactly one of amountUsd (to buy) or amount (to sell).' }
  }
  if (fromDollar) {
    if (request.amountUsd === undefined) {
      return { ok: false, error: 'A buy takes amountUsd, the dollars to spend.' }
    }
    const usd = parseUsd(request.amountUsd)
    if (!usd.ok) {
      return { ok: false, error: `amountUsd: ${usd.error}` }
    }
    if (usd.atomic === 0n) {
      return { ok: false, error: 'amountUsd: a buy must spend more than zero.' }
    }
    return { ok: true, side: 'buy', tokenIn: dollar, tokenOut: request.to, amountIn: usd.atomic }
  }
  if (request.amount === undefined || !ATOMIC.test(request.amount)) {
    return {
      ok: false,
      error:
        'A sell takes amount: a whole number above zero, in the smallest units of the token sold (get_portfolio shows them).',
    }
  }
  return {
    ok: true,
    side: 'sell',
    tokenIn: request.from,
    tokenOut: dollar,
    amountIn: BigInt(request.amount),
  }
}
