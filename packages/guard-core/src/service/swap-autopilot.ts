import type { ChainAdapter } from '@defimind/onchain'
import type { Amount, PayIntent, SwapQuote, TradingFlag } from '@defimind/shared'
import { addQuick } from '../db/day-book.js'
import * as repo from '../db/repo.js'
import { getPosition } from '../db/trades.js'
import { parseAmount, toAmount } from '../domain/amount.js'
import type { SwapRequest } from '../http/schemas.js'
import type { PaymentDeps } from './payments.js'
import { fetchQuote } from './swap-quote.js'

/**
 * CR-028: the exit of the whole position a buy or swap would leave, not of the trade alone, so a
 * position is never built bigger than its stops and the shield can sell. A sell, a first buy, or a
 * shadow agent with no booked position keeps the venue's own figure; a failed quote is no exit.
 */
export async function wholeExit(
  deps: PaymentDeps,
  adapter: ChainAdapter,
  req: Pick<SwapRequest, 'agentId' | 'chain'>,
  pair: { side: 'buy' | 'sell' | 'swap'; token: string },
  answer: SwapQuote,
  shadow: boolean,
): Promise<number | null> {
  if (pair.side === 'sell' || shadow || adapter.quoteSell === undefined) {
    return answer.exitImpactBps
  }
  const held = getPosition(deps.db, req.agentId, req.chain, pair.token).amount
  if (held === 0n) {
    return answer.exitImpactBps
  }
  const total = toAmount(held + parseAmount(answer.expectedOut))
  const quoted = await adapter.quoteSell(pair.token, total).catch(() => undefined)
  return quoted?.priceImpactBps ?? null
}

/**
 * An order's fill, quoted so its own minimum is the order's floor or more (CR-028). The venue's
 * minimum is its expected amount less the slippage asked, so a stop that fires at its trigger
 * would never clear a floor of the trigger less that same slippage: the fill asks for only the
 * room left between the expected amount and the floor. Below the floor it is refused.
 */
export async function toFloor(
  adapter: ChainAdapter,
  req: SwapRequest,
  answer: SwapQuote,
  floor: { minAmountOut: Amount },
  slippage: number,
): Promise<SwapQuote | undefined> {
  const least = parseAmount(floor.minAmountOut)
  if (parseAmount(answer.minAmountOut) >= least) {
    return answer
  }
  const expected = parseAmount(answer.expectedOut)
  const room = expected > least ? Number(((expected - least) * 10_000n) / expected) : 0
  if (room < 1) {
    return undefined
  }
  const again = await fetchQuote(adapter, req, Math.min(slippage, room))
  return again === 'no_route' || parseAmount(again.minAmountOut) < least ? undefined : again
}

/** CR-028: a first buy decided without the owner uses the day's room, at what it is worth. */
export function noteQuick(
  deps: PaymentDeps,
  intent: PayIntent,
  worth: Amount,
  flags: TradingFlag[],
) {
  const { db, now } = deps
  addQuick(db, intent.agentId, intent.chain, repo.utcDay(now()), worth)
  repo.audit(
    db,
    { event: 'quick_first_buy', intentId: intent.id, agentId: intent.agentId, detail: { flags } },
    now(),
  )
}
