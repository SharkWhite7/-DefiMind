import type { Amount, Order, OrderKind, Policy, RejectCode } from '@defimind/shared'
import { parseAmount } from './amount.js'

const BPS = 10_000n

const MAX_OPEN = 10

/**
 * Why an order may not be placed (CR-026). The open orders on a token may not add up to more than
 * the position; `held` is unset in shadow mode, which holds no positions to check against.
 */
export function placeReasons(
  policy: Policy,
  order: { token: string; amount: Amount; maxSlippageBps: number },
  open: Order[],
  held: bigint | undefined,
): RejectCode[] {
  const trading = policy.trading
  if (trading === undefined || !trading.enabled) {
    return ['TRADING_DISABLED']
  }
  const reasons: RejectCode[] = []
  if (trading.orders?.enabled !== true) {
    reasons.push('ORDERS_DISABLED')
  }
  if (open.length >= (trading.orders?.maxOpen ?? MAX_OPEN)) {
    reasons.push('ORDER_LIMIT_EXCEEDED')
  }
  const promised = open
    .filter((o) => o.token === order.token)
    .reduce((sum, o) => sum + parseAmount(o.amount), parseAmount(order.amount))
  if (held !== undefined && promised > held) {
    reasons.push('INSUFFICIENT_POSITION')
  }
  if (order.maxSlippageBps > trading.maxSlippageBps) {
    reasons.push('SLIPPAGE_TOO_HIGH')
  }
  return reasons
}

/** A take-profit triggers at or above its price, a stop-loss at or below it. */
export function hits(kind: OrderKind, out: bigint, triggerOut: bigint): boolean {
  return kind === 'take_profit' ? out >= triggerOut : out <= triggerOut
}

export interface Streak {
  checks: number
  /** When the first of these consecutive hits was seen, in ms. */
  since: number
}

/**
 * One check of an order's price. A miss starts over; a check whose impact is above the policy's
 * limit does not count either way, so a thin pool cannot fake or break a run of hits.
 */
export function step(
  streak: Streak | undefined,
  check: { hit: boolean; priceImpactBps: number; at: number },
  maxImpactBps: number,
): Streak | undefined {
  if (check.priceImpactBps > maxImpactBps) {
    return streak
  }
  if (!check.hit) {
    return undefined
  }
  return { checks: (streak?.checks ?? 0) + 1, since: streak?.since ?? check.at }
}

/** Enough consecutive hits, over long enough, that one block's price cannot fire the order. */
export function confirmed(
  streak: Streak | undefined,
  at: number,
  rules: { confirmChecks: number; confirmSeconds: number },
): boolean {
  return (
    streak !== undefined &&
    streak.checks >= rules.confirmChecks &&
    at - streak.since >= rules.confirmSeconds * 1000
  )
}

/** The least a fill may bring: the trigger, less the order's slippage, rounded down. */
export function fillFloor(order: Pick<Order, 'triggerOut' | 'maxSlippageBps'>): bigint {
  return (parseAmount(order.triggerOut) * (BPS - BigInt(order.maxSlippageBps))) / BPS
}
