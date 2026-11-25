import type { Amount, Policy, TradingPolicy } from '@defimind/shared'
import { parseAmount } from './amount.js'
import type { StoredPolicy } from './policy.js'

const LIMITS = ['perTxMax', 'dailyMax', 'approvalThreshold'] as const
const LISTS = ['chains', 'tokens', 'allowedRecipients', 'allowedDomains'] as const

/**
 * The fields a policy change loosens: SPEC's list (a raised limit, anything added to an allowlist,
 * going live, no longer requiring a mandate), plus three it leaves out. Unpausing here is a resume
 * without the resume's passkey, and a higher breaker or price-jump limit lets more through. Any of
 * them needs the owner's passkey; a change that only tightens needs the session alone.
 * `stopsOpen` says whether the agent has an open stop: turning orders off then cancels the stops
 * that protect its positions, so it counts as a loosening (CR-028).
 */
export function loosened(before: StoredPolicy, after: Policy, stopsOpen = false): string[] {
  const raised = LIMITS.filter((limit) => parseAmount(after[limit]) > parseAmount(before[limit]))
  const added = LISTS.filter((list) => after[list].some((item) => !before[list].includes(item)))
  return [
    ...raised,
    ...added,
    ...(after.mode === 'live' && before.mode !== 'live' ? ['mode'] : []),
    ...(after.requireMandate === false && before.requireMandate ? ['requireMandate'] : []),
    ...(!after.paused && before.paused ? ['paused'] : []),
    ...((after.maxPaymentsPerMinute ?? 0) > before.maxPaymentsPerMinute
      ? ['maxPaymentsPerMinute']
      : []),
    ...((after.priceIncreaseMaxPct ?? 0) > before.priceIncreaseMaxPct
      ? ['priceIncreaseMaxPct']
      : []),
    // A PUT without trading keeps the stored one (repo.putPolicy), so it loosens nothing there.
    ...(after.trading === undefined
      ? []
      : tradingLoosened(before.trading, after.trading, stopsOpen)
    ).map((field) => `trading.${field}`),
  ]
}

const TRADE_LIMITS = ['maxTradeUsd', 'dailyTradeMax', 'maxPositionUsd'] as const
const TRADE_BPS = ['maxSlippageBps', 'maxPriceImpactBps'] as const

/** No trading policy trades nothing, so it compares as one that allows nothing (CR-021). */
const CLOSED: TradingPolicy = {
  enabled: false,
  venues: [],
  tokens: [],
  allowAnyToken: false,
  maxTradeUsd: '0',
  dailyTradeMax: '0',
  maxPositionUsd: '0',
  maxSlippageBps: 0,
  maxPriceImpactBps: 0,
}

function tradingLoosened(
  before: TradingPolicy = CLOSED,
  after: TradingPolicy = CLOSED,
  stopsOpen = false,
): string[] {
  const ordersOn = (policy: TradingPolicy) => policy.orders?.enabled ?? false
  return [
    ...(after.enabled && !before.enabled ? ['enabled'] : []),
    ...(after.allowAnyToken && !before.allowAnyToken ? ['allowAnyToken'] : []),
    ...(['venues', 'tokens'] as const).filter((list) =>
      after[list].some((item) => !before[list].includes(item)),
    ),
    ...TRADE_LIMITS.filter((limit) => parseAmount(after[limit]) > parseAmount(before[limit])),
    ...TRADE_BPS.filter((limit) => after[limit] > before[limit]),
    ...Object.keys({ ...before.tokenLimits, ...after.tokenLimits })
      .filter((mint) => amountsLoosened(before.tokenLimits?.[mint], after.tokenLimits?.[mint]))
      .map((mint) => `tokenLimits.${mint}`),
    ...(['buy', 'sell', 'swap'] as const)
      .filter((kind) => amountsLoosened(before.operations?.[kind], after.operations?.[kind]))
      .map((kind) => `operations.${kind}`),
    ...(ordersOn(after) !== ordersOn(before) && (ordersOn(after) || stopsOpen)
      ? ['orders.enabled']
      : []),
    ...((after.orders?.maxOpen ?? 10) > (before.orders?.maxOpen ?? 10) ? ['orders.maxOpen'] : []),
  ]
}

/**
 * CR-026: a set of caps loosens when a cap is added, raised or removed. Only lowering one that
 * was there tightens: an added cap may replace a stricter default, a removed one leaves none.
 */
function amountsLoosened<T extends object>(before: T | undefined, after: T | undefined): boolean {
  const caps = (value: T | undefined) => (value ?? {}) as Partial<Record<string, Amount>>
  const fields = new Set([...Object.keys(caps(before)), ...Object.keys(caps(after))])
  return [...fields].some((field) => {
    const was = caps(before)[field]
    const now = caps(after)[field]
    return was === undefined || now === undefined || parseAmount(now) > parseAmount(was)
  })
}
