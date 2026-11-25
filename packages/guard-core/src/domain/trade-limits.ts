import type { RejectCode, TradingPolicy } from '@defimind/shared'
import { parseAmount } from './amount.js'

/** What the agent's trading so far means for this trade, from executed swaps. */
export interface Book {
  /** Today's buys, in the chain's dollar. */
  tradedToday: bigint
  /** Today's sells, valued at the dollars each one was quoted to bring at least. */
  soldToday: bigint
  /** What the agent holds of `token`, at cost. */
  positionCost: bigint
  /**
   * What the agent holds of `token`, in its atomic units. Unset where nothing is held to check
   * against: shadow mode books no positions, and the owner's Close sells what the chain holds.
   */
  positionAmount?: bigint
  /** Whether any buy of `token` has ever executed, for any agent. */
  boughtBefore: boolean
}

/**
 * The limits one trade meets (CR-026): per operation, per token, and never more than the agent
 * holds. A buy is valued at what it spends; a sell at the dollars its quote brings at least.
 * Absent operations and token limits keep CR-021's behaviour.
 */
export function limitReasons(
  trading: TradingPolicy,
  trade: { side: 'buy' | 'sell'; token: string; amountIn: bigint; valueUsd: bigint },
  book: Book,
): RejectCode[] {
  return trade.side === 'buy' ? buyLimits(trading, trade, book) : sellLimits(trading, trade, book)
}

function buyLimits(
  trading: TradingPolicy,
  { token, amountIn }: { token: string; amountIn: bigint },
  book: Book,
): RejectCode[] {
  const reasons: RejectCode[] = []
  const operation = trading.operations?.buy
  const own = trading.tokenLimits?.[token]
  if (amountIn > parseAmount(operation?.maxTradeUsd ?? trading.maxTradeUsd)) {
    reasons.push('TRADE_EXCEEDED')
  }
  if (book.tradedToday + amountIn > parseAmount(operation?.dailyMax ?? trading.dailyTradeMax)) {
    reasons.push('TRADE_DAILY_EXCEEDED')
  }
  const held = book.positionCost + amountIn
  // A token's own limits only lower its buy; its held limit replaces the default one.
  const overBuy = own?.maxBuyUsd !== undefined && amountIn > parseAmount(own.maxBuyUsd)
  const overHeld = own?.maxHeldUsd !== undefined && held > parseAmount(own.maxHeldUsd)
  if (overBuy || overHeld) {
    reasons.push('TOKEN_LIMIT_EXCEEDED')
  }
  if (own?.maxHeldUsd === undefined && held > parseAmount(trading.maxPositionUsd)) {
    reasons.push('POSITION_EXCEEDED')
  }
  return reasons
}

function sellLimits(
  trading: TradingPolicy,
  { amountIn, valueUsd }: { amountIn: bigint; valueUsd: bigint },
  book: Book,
): RejectCode[] {
  const reasons: RejectCode[] = []
  if (book.positionAmount !== undefined && amountIn > book.positionAmount) {
    reasons.push('INSUFFICIENT_POSITION')
  }
  const operation = trading.operations?.sell
  if (operation !== undefined) {
    if (valueUsd > parseAmount(operation.maxTradeUsd)) {
      reasons.push('SELL_EXCEEDED')
    }
    if (book.soldToday + valueUsd > parseAmount(operation.dailyMax)) {
      reasons.push('SELL_DAILY_EXCEEDED')
    }
  }
  return reasons
}
