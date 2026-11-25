import type { Order } from '@defimind/shared'
import { moveOrder, openOrders, raisePeak, triggeredOrders } from '../db/orders.js'
import * as repo from '../db/repo.js'
import { getPosition } from '../db/trades.js'
import { parseAmount, toAmount } from '../domain/amount.js'
import {
  climb,
  confirmed,
  fillFloor,
  hits,
  step,
  type Rise,
  type Streak,
} from '../domain/orders.js'
import type { PaymentDeps } from './payments.js'
import { swap } from './swap.js'
import { VenueUnavailable } from './swap-quote.js'
import { adapterFor } from './wallets.js'

export interface WatchRules {
  confirmChecks: number
  confirmSeconds: number
  /** The watcher's own pace: a run of hits with a gap of more than twice this starts over. */
  checkMs: number
}

/**
 * The order watcher (CR-026). Each tick quotes every open order for its whole amount through the
 * agent's own wallet, and fills one only after enough unbroken hits. A paused agent's orders stay
 * open and their run starts over; the run is held in memory, so a restart starts it over too.
 * A trailing stop's high (CR-028) is stored, and moves only on a confirming run.
 */
export function orderWatcher(deps: PaymentDeps, rules: WatchRules) {
  const streaks = new Map<string, Streak>()
  const rises = new Map<string, Rise>()

  function forget(id: string) {
    streaks.delete(id)
    rises.delete(id)
  }

  async function check(order: Order): Promise<void> {
    const { db, now } = deps
    const at = now()
    if (order.expiresAt !== undefined && Date.parse(order.expiresAt) <= at.getTime()) {
      forget(order.id)
      close(order, 'cancelled', {}, 'order_expired')
      return
    }
    const policy = repo.getPolicy(db, order.agentId)
    const adapter = adapterFor(deps, order.agentId, order.chain)
    if (policy === undefined || policy.paused || adapter?.quoteSell === undefined) {
      forget(order.id)
      return
    }
    const held = getPosition(db, order.agentId, order.chain, order.token).amount
    if (policy.mode !== 'shadow' && held < parseAmount(order.amount)) {
      forget(order.id)
      close(order, 'failed', { failReason: 'INSUFFICIENT_POSITION' }, 'order_failed')
      return
    }
    const quoted = await adapter.quoteSell(order.token, order.amount).catch(() => undefined)
    if (quoted === undefined) {
      forget(order.id)
      return
    }
    const out = parseAmount(quoted.out)
    const maxImpact = policy.trading?.maxPriceImpactBps ?? 0
    const watched = order.kind === 'trailing_stop' ? raise(order, out, quoted, maxImpact) : order
    const hit = hits(watched, out)
    const check = { hit, priceImpactBps: quoted.priceImpactBps, at: at.getTime() }
    const streak = step(streaks.get(order.id), check, maxImpact, 2 * rules.checkMs)
    if (streak === undefined) {
      streaks.delete(order.id)
      return
    }
    streaks.set(order.id, streak)
    if (confirmed(streak, at.getTime(), rules)) {
      forget(order.id)
      await fill(watched)
    }
  }

  /** The order with its high moved up to a level held over a whole confirming run, if any. */
  function raise(order: Order, out: bigint, quoted: { priceImpactBps: number }, maxImpact: number) {
    const check = { out, priceImpactBps: quoted.priceImpactBps, at: deps.now().getTime() }
    const { rise, level } = climb(rises.get(order.id) ?? [], check, {
      ...rules,
      maxImpactBps: maxImpact,
      maxGapMs: 2 * rules.checkMs,
    })
    rises.set(order.id, rise)
    if (
      level === undefined ||
      (order.peakOut !== undefined && level <= parseAmount(order.peakOut))
    ) {
      return order
    }
    const peakOut = toAmount(level)
    raisePeak(deps.db, order.id, peakOut)
    return { ...order, peakOut }
  }

  /** A sell to the dollar that must bring at least the trigger less slippage, never any price. */
  async function fill(order: Order): Promise<void> {
    if (!moveOrder(deps.db, order.id, 'triggered')) {
      return
    }
    const dollar = deps.usdc.get(order.chain) ?? ''
    const request = {
      agentId: order.agentId,
      chain: order.chain,
      tokenIn: order.token,
      tokenOut: dollar,
      amountIn: order.amount,
      maxSlippageBps: order.maxSlippageBps,
      reason: `order: ${order.kind}`,
    }
    const floor = { minAmountOut: toAmount(fillFloor(order)), by: 'order' as const }
    let intent
    try {
      intent = await swap(deps, request, floor)
    } catch (error) {
      if (error instanceof VenueUnavailable) {
        // The venue went down between the trigger and the sell: the order waits for the next run.
        moveOrder(deps.db, order.id, 'open', {}, 'triggered')
        return
      }
      // Never left triggered: Close and kill cancel only open orders, so it would die unseen.
      deps.log.error({ err: error, orderId: order.id }, 'order fill failed')
      close(order, 'failed', { failReason: 'SIM_FAILED' }, 'order_failed', 'triggered')
      return
    }
    if (intent.status === 'executed' || intent.status === 'shadowed') {
      close(order, 'filled', { filledIntentId: intent.id }, 'order_filled', 'triggered')
      return
    }
    const failReason = intent.rejectReasons[0] ?? 'SIM_FAILED'
    // CR-028: refused on price, it watches again, so a gap-down never disarms a stop for good.
    if (
      failReason === 'SLIPPAGE_TOO_HIGH' &&
      moveOrder(deps.db, order.id, 'open', {}, 'triggered')
    ) {
      const detail = { id: order.id, kind: order.kind, reopened: true, filledIntentId: intent.id }
      repo.audit(deps.db, { event: 'order_failed', agentId: order.agentId, detail }, deps.now())
      deps.push?.order('order_failed', order, intent.id, true)
      return
    }
    close(order, 'failed', { failReason, filledIntentId: intent.id }, 'order_failed', 'triggered')
  }

  function close(
    order: Order,
    to: 'cancelled' | 'filled' | 'failed',
    extra: Parameters<typeof moveOrder>[3],
    event: 'order_expired' | 'order_filled' | 'order_failed',
    from: 'open' | 'triggered' = 'open',
  ) {
    if (!moveOrder(deps.db, order.id, to, extra, from)) {
      return
    }
    const detail = { id: order.id, kind: order.kind, ...extra }
    repo.audit(deps.db, { event, agentId: order.agentId, detail }, deps.now())
    if (event !== 'order_expired') {
      deps.push?.order(event, order, extra?.filledIntentId)
    }
  }

  // A sell under way when guard-core stopped cannot be resumed: its order fails, and says so.
  let recovered = false
  function recover() {
    recovered = true
    for (const order of triggeredOrders(deps.db)) {
      close(order, 'failed', { failReason: 'SIM_FAILED' }, 'order_failed', 'triggered')
    }
  }

  return {
    async tick(): Promise<void> {
      if (!recovered) {
        recover()
      }
      for (const order of openOrders(deps.db)) {
        try {
          await check(order)
        } catch (error) {
          deps.log.error({ err: error, orderId: order.id }, 'order check failed')
        }
      }
    },
  }
}
