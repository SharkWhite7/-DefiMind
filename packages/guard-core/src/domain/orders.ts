import type { Amount, Order, Policy, RejectCode } from '@defimind/shared'
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

/**
 * The level an order fires at. A trailing stop's is its confirmed high less the trail, never under
 * its floor; with neither a floor nor a high yet, it has none.
 */
export function triggerOf(order: Pick<Order, 'kind' | 'triggerOut' | 'trailBps' | 'peakOut'>) {
  const floor = parseAmount(order.triggerOut)
  if (order.kind !== 'trailing_stop' || order.peakOut === undefined) {
    return floor
  }
  const trailed = (parseAmount(order.peakOut) * (BPS - BigInt(order.trailBps ?? 0))) / BPS
  return trailed > floor ? trailed : floor
}

/** A take-profit triggers at or above its level, a stop at or below it, and nothing at zero. */
export function hits(
  order: Pick<Order, 'kind' | 'triggerOut' | 'trailBps' | 'peakOut'>,
  out: bigint,
) {
  const trigger = triggerOf(order)
  return order.kind === 'take_profit' ? out >= trigger : trigger > 0n && out <= trigger
}

export interface Streak {
  checks: number
  /** When the first of these consecutive hits was seen, in ms. */
  since: number
  /** When the last one was, so a gap in the checks breaks the run. */
  last: number
}

/**
 * One check of an order's price. A run of hits must be unbroken: a miss, a check whose impact is
 * above the policy's limit, or a gap longer than `maxGapMs` since the last hit starts it over.
 */
export function step(
  streak: Streak | undefined,
  check: { hit: boolean; priceImpactBps: number; at: number },
  maxImpactBps: number,
  maxGapMs: number,
): Streak | undefined {
  if (!check.hit || check.priceImpactBps > maxImpactBps) {
    return undefined
  }
  const run = streak !== undefined && check.at - streak.last <= maxGapMs ? streak : undefined
  return { checks: (run?.checks ?? 0) + 1, since: run?.since ?? check.at, last: check.at }
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
export function fillFloor(
  order: Pick<Order, 'kind' | 'triggerOut' | 'trailBps' | 'peakOut' | 'maxSlippageBps'>,
): bigint {
  return (triggerOf(order) * (BPS - BigInt(order.maxSlippageBps))) / BPS
}

/** A trailing stop's recent valid quotes, newest last, at most confirmChecks of them. */
export type Rise = { out: bigint; at: number }[]

/**
 * One check toward a trailing stop's high (CR-028). The high is the lowest quote of a confirming
 * run, so a level must hold for the whole run: one spiked quote never moves it. A check above the
 * impact limit, or a gap, starts the run over.
 */
export function climb(
  rise: Rise,
  check: { out: bigint; priceImpactBps: number; at: number },
  rules: { confirmChecks: number; confirmSeconds: number; maxImpactBps: number; maxGapMs: number },
): { rise: Rise; level?: bigint } {
  if (check.priceImpactBps > rules.maxImpactBps) {
    return { rise: [] }
  }
  const last = rise.at(-1)
  const kept = last !== undefined && check.at - last.at <= rules.maxGapMs ? rise : []
  const next = [...kept, { out: check.out, at: check.at }].slice(-rules.confirmChecks)
  const first = next[0]
  if (
    first === undefined ||
    next.length < rules.confirmChecks ||
    check.at - first.at < rules.confirmSeconds * 1000
  ) {
    return { rise: next }
  }
  return { rise: next, level: next.reduce((low, c) => (c.out < low ? c.out : low), first.out) }
}
