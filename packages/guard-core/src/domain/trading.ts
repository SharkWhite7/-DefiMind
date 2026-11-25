import type {
  Policy,
  PolicyDecision,
  RejectCode,
  SwapDetails,
  SwapQuote,
  TradingFlag,
  TradingPolicy,
} from '@defimind/shared'
import { parseAmount } from './amount.js'
import { type Book, limitReasons } from './trade-limits.js'

export type { Book } from './trade-limits.js'

/** What a trading policy means for the fields it leaves out (SPEC v0.16). */
export const TRADING_DEFAULTS = { maxSlippageBps: 100, maxPriceImpactBps: 300 } as const

/** A quote older than this has moved on; a quote stamped later than this ahead is not believed. */
export const QUOTE_MAX_AGE_MS = 30_000
const QUOTE_SKEW_MS = 5_000

const BPS = 10_000n

/**
 * One swap as the policy sees it. A buy spends the chain's dollar on `token`, a sell turns `token`
 * back into it, and a swap (CR-026) trades another held token for `token`.
 */
export interface Trade {
  side: 'buy' | 'sell' | 'swap'
  /** The token that is not the chain's dollar; for a swap, the one it brings in. */
  token: string
  /**
   * A swap's worth in the chain's dollar, from two quotes back to it; undefined when either leg
   * could not be priced within the limits, which refuses the swap.
   */
  valueUsd?: bigint
  /** What the agent asked for: the quote must answer exactly this. */
  request: { tokenIn: string; tokenOut: string; amountIn: string; maxSlippageBps?: number }
  quote: SwapQuote
  /** CR-028: the AI trader buys a token its hunt was offered, which quick first buys may cover. */
  offered?: boolean
}

export interface TradeVerdict {
  decision: PolicyDecision
  reasons: RejectCode[]
  flags: TradingFlag[]
  /** CR-028: a first buy decided without the owner under quickFirstBuy. */
  quick?: boolean
}

/**
 * Default deny, as for payments: a swap is approved only when no rule objects. The quote comes
 * from a venue nobody trusts, so it is checked against the request and against itself, never
 * believed. Pure, so every attack case is a test.
 *
 * A protective sell (CR-028: a stop's fill) skips the sell limits and the mandate rule: an agent
 * must not be able to use up the room its own stops need to sell.
 */
export function evaluateTrade(
  trade: Trade,
  policy: Policy,
  book: Book,
  now: Date,
  protective = false,
): TradeVerdict {
  const trading = policy.trading
  if (trading === undefined || !trading.enabled) {
    return { decision: 'reject', reasons: ['TRADING_DISABLED'], flags: [] }
  }
  const reasons: RejectCode[] = []
  const add = (reason: RejectCode) => {
    if (!reasons.includes(reason)) {
      reasons.push(reason)
    }
  }
  if (policy.paused) {
    add('PAUSED')
  }
  // A swap cannot name a mandate yet, so an owner who allows payments only inside a task budget
  // gets no swaps at all until mandates have a design for trades.
  const { quote, request, side } = trade
  const guarded = protective && side === 'sell'
  if (policy.requireMandate === true && !guarded) {
    add('MANDATE_REQUIRED')
  }
  if (!trading.venues.includes(quote.venue)) {
    add('VENUE_NOT_ALLOWED')
  }
  // Selling is always allowed, so an agent can leave a token the owner has since taken off the list.
  const bringsIn = side !== 'sell'
  if (bringsIn && !trading.allowAnyToken && !trading.tokens.includes(trade.token)) {
    add('TOKEN_NOT_TRADABLE')
  }
  for (const reason of quoteReasons(trade, trading, now)) {
    add(reason)
  }

  const amountIn = parseAmount(request.amountIn)
  // A sell counts at what it is expected to bring: a cap is not slipped under on the slippage.
  const valueUsd =
    side === 'buy' ? amountIn : side === 'sell' ? parseAmount(quote.expectedOut) : trade.valueUsd
  if (valueUsd === undefined) {
    add('VALUATION_UNAVAILABLE')
  }
  for (const reason of limitReasons(
    trading,
    { side, token: trade.token, amountIn, valueUsd: valueUsd ?? 0n },
    book,
  )) {
    if (!(guarded && (reason === 'SELL_EXCEEDED' || reason === 'SELL_DAILY_EXCEEDED'))) {
      add(reason)
    }
  }
  if (bringsIn) {
    for (const risk of quote.risks) {
      add(risk)
    }
    const exit = quote.exitImpactBps
    if (exit === null || exit > trading.maxPriceImpactBps) {
      add('NO_EXIT_ROUTE')
    }
  }

  if (reasons.length > 0) {
    return { decision: 'reject', reasons, flags: [] }
  }
  // A sell never waits: holding a token is the risk, and the owner's own Close is a sell too.
  if (side === 'sell') {
    return { decision: 'approve', reasons: [], flags: [] }
  }
  const flags = buyFlags(quote, book)
  const value = valueUsd ?? 0n
  const overThreshold = value >= parseAmount(policy.approvalThreshold)
  const quick = !overThreshold && quickFirst(trading, trade, flags, value, book)
  const waits = (flags.length > 0 && !quick) || overThreshold
  return {
    decision: waits ? 'needs_approval' : 'approve',
    reasons: [],
    flags,
    ...(quick ? { quick } : {}),
  }
}

/**
 * CR-028: a first buy the owner let through without asking. Only NEW_TOKEN may be flagged, it must
 * fit the per-buy and per-day amounts, and the token must be one the owner listed or the AI
 * trader's hunt was offered: a token admitted only by allowAnyToken always waits, so a leaked
 * agent key cannot use it on fresh mints.
 */
function quickFirst(
  trading: TradingPolicy,
  trade: Trade,
  flags: TradingFlag[],
  value: bigint,
  book: Book,
): boolean {
  const quick = trading.quickFirstBuy
  return (
    quick !== undefined &&
    flags.length === 1 &&
    flags[0] === 'NEW_TOKEN' &&
    value <= parseAmount(quick.maxUsd) &&
    book.quickToday + value <= parseAmount(quick.dailyUsd) &&
    (trading.tokens.includes(trade.token) || trade.offered === true)
  )
}

/** The quote answers the request, keeps its own promises, and is fresh. */
function quoteReasons(trade: Trade, trading: TradingPolicy, now: Date): RejectCode[] {
  const { quote, request } = trade
  const reasons: RejectCode[] = []
  const answers =
    quote.tokenIn === request.tokenIn &&
    quote.tokenOut === request.tokenOut &&
    quote.amountIn === request.amountIn
  const minOut = parseAmount(quote.minAmountOut)
  const expected = parseAmount(quote.expectedOut)
  if (!answers || minOut === 0n || minOut > expected) {
    reasons.push('SIM_UNEXPECTED_EFFECT')
  }
  // The slippage the minimum really allows, not the one the venue reports.
  const slippage = Math.min(trading.maxSlippageBps, request.maxSlippageBps ?? Infinity)
  if (quote.slippageBps > slippage || minOut * BPS < expected * (BPS - BigInt(slippage))) {
    reasons.push('SLIPPAGE_TOO_HIGH')
  }
  if (quote.priceImpactBps > trading.maxPriceImpactBps) {
    reasons.push('PRICE_IMPACT_TOO_HIGH')
  }
  const age = now.getTime() - Date.parse(quote.quotedAt)
  if (!(age <= QUOTE_MAX_AGE_MS && age >= -QUOTE_SKEW_MS)) {
    reasons.push('QUOTE_STALE')
  }
  return reasons
}

/** The venue may know the mint's authority; only guard-core knows what has been bought before. */
function buyFlags(quote: SwapQuote, book: Book): TradingFlag[] {
  const flags = quote.flags.filter((flag) => flag === 'MINT_AUTHORITY')
  return book.boughtBefore ? flags : ['NEW_TOKEN', ...flags]
}

/** What a recorded swap was expected to bring. One recorded before CR-026 kept only its minimum. */
export function expectedOf(swap: SwapDetails | undefined): bigint {
  return parseAmount(swap?.expectedOut ?? swap?.minAmountOut ?? '0')
}
