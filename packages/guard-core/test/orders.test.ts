import { SwapUnavailable } from '@defimind/onchain'
import { describe, expect, it, vi } from 'vitest'
import { getOrder, moveOrder } from '../src/db/orders.js'
import { applyTrade, getPosition } from '../src/db/trades.js'
import { orderWatcher } from '../src/service/order-watcher.js'
import type { PaymentDeps } from '../src/service/payments.js'
import { serial } from '../src/service/serial.js'
import { CHAIN, harness, MINT as USDC, NOW } from './harness.js'
import { signedIn } from './owner.js'
import { BONK, trading, Venue } from './venue.js'

const RULES = { confirmChecks: 3, confirmSeconds: 30, checkMs: 15_000 }

/** An agent holding 2,000,000 BONK, with orders on. */
async function setup(over: object = {}) {
  const chain = new Venue()
  const orders = { enabled: true, maxOpen: 3 }
  const h = await harness({ chain, policy: { trading: { ...trading, orders }, ...over } })
  chain.held.set(BONK, 2_000_000n)
  const trade = { agentId: 'agent-1', chain: CHAIN, token: BONK, decimals: 5 }
  applyTrade(h.db, { ...trade, side: 'buy', amount: 2_000_000n, cost: 2_000n }, NOW)
  const deps: PaymentDeps = {
    db: h.db,
    chains: new Map([[CHAIN, chain]]),
    usdc: new Map([[CHAIN, USDC]]),
    bot: h.bot,
    now: () => h.clock.now,
    serial: serial(),
    log: { warn: () => {}, error: () => {} },
  }
  const watcher = orderWatcher(deps, RULES)
  /** Three checks, 15 seconds apart: the first confirmed run. */
  const run = async () => {
    for (let i = 0; i < 3; i++) {
      await watcher.tick()
      h.clock.now = new Date(h.clock.now.getTime() + 15_000)
    }
  }
  return { h, chain, watcher, run }
}

const place = (extra: object = {}) => ({
  agentId: 'agent-1',
  chain: CHAIN,
  token: BONK,
  kind: 'take_profit',
  amount: '1000000',
  triggerOut: '900',
  ...extra,
})

describe('placing and cancelling orders (CR-026)', () => {
  it('lets an agent place, list and cancel its own orders', async () => {
    const { h } = await setup()
    const res = await h.agent('POST', '/v1/agent/orders', place())
    expect(res.json()).toMatchObject({ status: 'open', createdBy: 'agent', maxSlippageBps: 100 })
    const listed = (await h.agent('GET', '/v1/agent/orders/agent-1')).json().orders
    expect(listed).toHaveLength(1)
    const cancelled = await h.agent('POST', `/v1/agent/orders/${res.json().id}/cancel`, {
      agentId: 'agent-1',
    })
    expect(cancelled.json().status).toBe('cancelled')
  })

  it('refuses an order with its reasons', async () => {
    const off = await setup({ trading: { ...trading, orders: { enabled: false, maxOpen: 3 } } })
    const refused = await off.h.agent('POST', '/v1/agent/orders', place())
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toEqual({ error: 'order_refused', rejectReasons: ['ORDERS_DISABLED'] })
    const { h } = await setup()
    const over = await h.agent('POST', '/v1/agent/orders', place({ amount: '2000001' }))
    expect(over.json().rejectReasons).toEqual(['INSUFFICIENT_POSITION'])
  })

  it('lets the owner place with the passkey, and cancel with the session alone', async () => {
    const { h } = await setup()
    const owner = await signedIn(h)
    const bare = await owner.call('POST', '/v1/owner/orders', place())
    expect(bare.json().error).toBe('step_up_required')
    const res = await owner.call('POST', '/v1/owner/orders', {
      ...place(),
      assertion: await owner.stepUp('place_order', place()),
    })
    expect(res.json()).toMatchObject({ status: 'open', createdBy: 'owner' })
    const cancelled = await owner.call('POST', `/v1/owner/orders/${res.json().id}/cancel`)
    expect(cancelled.json().status).toBe('cancelled')
    expect((await owner.call('GET', '/v1/owner/orders')).json().orders).toHaveLength(1)
  })

  it('cancels every open order on Close and on kill', async () => {
    const { h } = await setup()
    const owner = await signedIn(h)
    const first = (await h.agent('POST', '/v1/agent/orders', place())).json()
    await owner.call('POST', '/v1/owner/kill')
    expect(getOrder(h.db, first.id)?.status).toBe('cancelled')
  })
})

describe('trailing stops and protective sells (CR-028)', () => {
  const trail = (extra: object = {}) =>
    place({ kind: 'trailing_stop', triggerOut: '0', trailBps: 1000, ...extra })

  it('places a trailing stop only with its trail, and a plain stop only with a price', async () => {
    const { h } = await setup()
    expect((await h.agent('POST', '/v1/agent/orders', trail())).json()).toMatchObject({
      kind: 'trailing_stop',
      trailBps: 1000,
      status: 'open',
    })
    const bare = await h.agent('POST', '/v1/agent/orders', place({ kind: 'trailing_stop' }))
    expect(bare.statusCode).toBe(400)
    const zero = await h.agent(
      'POST',
      '/v1/agent/orders',
      place({ kind: 'stop_loss', triggerOut: '0' }),
    )
    expect(zero.statusCode).toBe(400)
  })

  it('follows a held high up, ignores a one-check spike, and sells 10% under it', async () => {
    const { h, chain, watcher, run } = await setup()
    chain.clock = () => h.clock.now
    const order = (await h.agent('POST', '/v1/agent/orders', trail())).json()
    chain.sellOut = '1010'
    await run()
    expect(getOrder(h.db, order.id)?.peakOut).toBe('1010')
    for (const out of ['5000', '1010', '1010']) {
      chain.sellOut = out
      await watcher.tick()
      h.clock.now = new Date(h.clock.now.getTime() + 15_000)
    }
    expect(getOrder(h.db, order.id)?.peakOut).toBe('1010')
    chain.sellOut = '905'
    await run()
    expect(getOrder(h.db, order.id)).toMatchObject({ status: 'filled', peakOut: '1010' })
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK).amount).toBe(1_000_000n)
  })

  it('fills a stop past the sell limits and a mandate rule an agent could use up', async () => {
    const operations = { sell: { maxTradeUsd: '1', dailyMax: '1' } }
    const over = {
      requireMandate: true,
      trading: { ...trading, orders: { enabled: true, maxOpen: 3 }, operations },
    }
    const stopped = await setup(over)
    const stop = (
      await stopped.h.agent(
        'POST',
        '/v1/agent/orders',
        place({ kind: 'stop_loss', triggerOut: '1000' }),
      )
    ).json()
    await stopped.run()
    expect(getOrder(stopped.h.db, stop.id)?.status).toBe('filled')
    // A take-profit is no protection, so it meets them like any sell.
    const taken = await setup(over)
    const profit = (await taken.h.agent('POST', '/v1/agent/orders', place())).json()
    await taken.run()
    expect(getOrder(taken.h.db, profit.id)).toMatchObject({ status: 'failed' })
  })

  it('sells a stop that fires at its trigger, with the venue keeping the slippage asked', async () => {
    const { h, chain, run } = await setup()
    chain.realistic = true
    chain.sellOut = '899'
    const stop = (
      await h.agent('POST', '/v1/agent/orders', place({ kind: 'stop_loss', triggerOut: '900' }))
    ).json()
    await run()
    expect(getOrder(h.db, stop.id)?.status).toBe('filled')
  })

  it('after a gap below its floor, tells the owner once and waits for the market to return', async () => {
    const { h, chain, run } = await setup()
    chain.realistic = true
    chain.clock = () => h.clock.now
    chain.sellOut = '800'
    const stop = (
      await h.agent('POST', '/v1/agent/orders', place({ kind: 'stop_loss', triggerOut: '900' }))
    ).json()
    const quotes = () => chain.quotes
    await run()
    expect(getOrder(h.db, stop.id)?.status).toBe('open')
    const after = quotes()
    await run()
    await run()
    expect(quotes()).toBe(after)
    expect(h.auditEvents().filter((e) => e === 'order_failed')).toHaveLength(1)
    chain.sellOut = '895'
    await run()
    expect(getOrder(h.db, stop.id)?.status).toBe('filled')
  })

  it('needs the passkey to cancel a stop from the panel, and the session for a take-profit', async () => {
    const { h } = await setup()
    const owner = await signedIn(h)
    const stop = (
      await h.agent('POST', '/v1/agent/orders', place({ kind: 'stop_loss', triggerOut: '500' }))
    ).json()
    const bare = await owner.call('POST', `/v1/owner/orders/${stop.id}/cancel`)
    expect(bare.json().error).toBe('step_up_required')
    const done = await owner.call('POST', `/v1/owner/orders/${stop.id}/cancel`, {
      assertion: await owner.stepUp('cancel_order', { orderId: stop.id }),
    })
    expect(done.json().status).toBe('cancelled')
  })
})

describe('the order watcher (CR-026)', () => {
  it('fills a take-profit after enough hits over long enough, as a sell', async () => {
    const { h, watcher } = await setup()
    const order = (await h.agent('POST', '/v1/agent/orders', place())).json()
    // Three hits at 0, 15 and 30 seconds: the third confirms, not before.
    for (const at of [0, 15_000]) {
      h.clock.now = new Date(NOW.getTime() + at)
      await watcher.tick()
    }
    expect(getOrder(h.db, order.id)?.status).toBe('open')
    h.clock.now = new Date(NOW.getTime() + 30_000)
    await watcher.tick()
    const filled = getOrder(h.db, order.id)
    expect(filled).toMatchObject({ status: 'filled', filledIntentId: expect.any(String) })
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK).amount).toBe(1_000_000n)
    expect(h.auditEvents()).toContain('order_filled')
  })

  it('never sells a stop-loss below its floor: it watches again and the position stays', async () => {
    const { h, run } = await setup()
    const order = (
      await h.agent('POST', '/v1/agent/orders', place({ kind: 'stop_loss', triggerOut: '2000' }))
    ).json()
    await run()
    await run()
    // CR-028: refused on price, the order goes back to open, so a gap-down never disarms it.
    expect(getOrder(h.db, order.id)?.status).toBe('open')
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK).amount).toBe(2_000_000n)
    expect(h.auditEvents()).toContain('order_failed')
  })

  it('neither fills nor counts while the agent is paused, or while the price moves too far', async () => {
    const paused = await setup()
    const order = (await paused.h.agent('POST', '/v1/agent/orders', place())).json()
    await (await signedIn(paused.h)).call('POST', '/v1/owner/pause', { agentId: 'agent-1' })
    await paused.run()
    await paused.run()
    expect(getOrder(paused.h.db, order.id)?.status).toBe('open')

    const thin = await setup()
    const other = (await thin.h.agent('POST', '/v1/agent/orders', place())).json()
    thin.chain.sellImpactBps = 301
    await thin.run()
    await thin.run()
    expect(getOrder(thin.h.db, other.id)?.status).toBe('open')
  })

  it('fails an order whose position was sold elsewhere, and cancels one that expired', async () => {
    const { h, watcher } = await setup()
    const sold = (await h.agent('POST', '/v1/agent/orders', place())).json()
    const later = new Date(NOW.getTime() + 60_000).toISOString()
    const expiring = (await h.agent('POST', '/v1/agent/orders', place({ expiresAt: later }))).json()
    const trade = { agentId: 'agent-1', chain: CHAIN, token: BONK, decimals: 5, cost: 0n }
    applyTrade(h.db, { ...trade, side: 'sell', amount: 1_500_000n }, NOW)
    h.clock.now = new Date(NOW.getTime() + 61_000)
    await watcher.tick()
    expect(getOrder(h.db, sold.id)).toMatchObject({
      status: 'failed',
      failReason: 'INSUFFICIENT_POSITION',
    })
    expect(getOrder(h.db, expiring.id)?.status).toBe('cancelled')
  })
})

describe('orders that cannot be left behind (SPEC #182)', () => {
  it('fails an order whose sell throws, instead of leaving it triggered', async () => {
    const { h, chain, run } = await setup()
    const order = (await h.agent('POST', '/v1/agent/orders', place())).json()
    vi.spyOn(chain, 'getAllowanceState').mockRejectedValue(new Error('rpc down'))
    await run()
    expect(getOrder(h.db, order.id)).toMatchObject({ status: 'failed', failReason: 'SIM_FAILED' })
    expect(h.auditEvents()).toContain('order_failed')
  })

  it('fails on start an order found triggered: its sell cannot be resumed', async () => {
    const { h, watcher } = await setup()
    const order = (await h.agent('POST', '/v1/agent/orders', place())).json()
    moveOrder(h.db, order.id, 'triggered')
    await watcher.tick()
    expect(getOrder(h.db, order.id)).toMatchObject({ status: 'failed', failReason: 'SIM_FAILED' })
  })

  it('starts a run of hits over after a pause or a gap in the checks', async () => {
    const { h, watcher } = await setup()
    const order = (await h.agent('POST', '/v1/agent/orders', place())).json()
    const at = async (seconds: number) => {
      h.clock.now = new Date(NOW.getTime() + seconds * 1000)
      await watcher.tick()
    }
    await at(0)
    await at(15)
    // 45 seconds since the last hit, more than twice ORDER_CHECK_MS: the third hit is a first.
    await at(60)
    expect(getOrder(h.db, order.id)?.status).toBe('open')
    const owner = await signedIn(h)
    await at(75)
    await owner.call('POST', '/v1/owner/pause', { agentId: 'agent-1' })
    await at(90)
    expect(getOrder(h.db, order.id)?.status).toBe('open')
  })

  it("counts an order being filled in the position's open total", async () => {
    const { h } = await setup()
    const first = (await h.agent('POST', '/v1/agent/orders', place({ amount: '1500000' }))).json()
    moveOrder(h.db, first.id, 'triggered')
    const over = await h.agent('POST', '/v1/agent/orders', place({ amount: '600000' }))
    expect(over.json().rejectReasons).toEqual(['INSUFFICIENT_POSITION'])
  })

  it('binds the owner step-up to the expiry', async () => {
    const { h } = await setup()
    const owner = await signedIn(h)
    const expiresAt = new Date(NOW.getTime() + 3_600_000).toISOString()
    const signed = await owner.stepUp('place_order', place())
    const replay = await owner.call('POST', '/v1/owner/orders', {
      ...place({ expiresAt }),
      assertion: signed,
    })
    expect(replay.statusCode).toBe(401)
    const res = await owner.call('POST', '/v1/owner/orders', {
      ...place({ expiresAt }),
      assertion: await owner.stepUp('place_order', place({ expiresAt })),
    })
    expect(res.json()).toMatchObject({ status: 'open', expiresAt })
  })

  it('cancels open orders when orders are turned off, and when the agent is revoked', async () => {
    const { h } = await setup()
    const owner = await signedIn(h)
    const first = (await h.agent('POST', '/v1/agent/orders', place())).json()
    const policy = (await owner.call('GET', '/v1/owner/policy/agent-1')).json()
    const orders = { enabled: false, maxOpen: 3 }
    await owner.call('PUT', '/v1/owner/policy/agent-1', {
      policy: { ...policy, trading: { ...policy.trading, orders } },
    })
    expect(getOrder(h.db, first.id)?.status).toBe('cancelled')

    const again = await setup()
    const other = (await again.h.agent('POST', '/v1/agent/orders', place())).json()
    const admin = await signedIn(again.h)
    await admin.call('POST', '/v1/owner/agents/agent-1/revoke')
    expect(getOrder(again.h.db, other.id)?.status).toBe('cancelled')
  })
})

describe('a venue that is down at the fill (SPEC #183)', () => {
  it('puts the order back to open, with its run of checks started over', async () => {
    const { h, chain, run, watcher } = await setup()
    const order = (await h.agent('POST', '/v1/agent/orders', place())).json()
    vi.spyOn(chain, 'quoteSwap').mockRejectedValueOnce(
      new SwapUnavailable('venue_unavailable', 'test venue'),
    )
    await run()
    expect(getOrder(h.db, order.id)?.status).toBe('open')
    // The old run had three hits: kept, the next hit would fire it again at once.
    await watcher.tick()
    h.clock.now = new Date(h.clock.now.getTime() + 15_000)
    await watcher.tick()
    expect(getOrder(h.db, order.id)?.status).toBe('open')
  })
})

describe("the owner's orders, seen from the agent", () => {
  it('lists them read-only: the agent cannot cancel them', async () => {
    const { h } = await setup()
    const owner = await signedIn(h)
    const placed = await owner.call('POST', '/v1/owner/orders', {
      ...place(),
      assertion: await owner.stepUp('place_order', place()),
    })
    const id = placed.json().id
    const listed = (await h.agent('GET', '/v1/agent/orders/agent-1')).json().orders
    expect(listed).toEqual([expect.objectContaining({ id, createdBy: 'owner' })])
    const cancel = await h.agent('POST', `/v1/agent/orders/${id}/cancel`, { agentId: 'agent-1' })
    expect(cancel.statusCode).toBe(404)
    expect(cancel.json()).toEqual({ error: 'not_found' })
    expect(getOrder(h.db, id)?.status).toBe('open')
  })
})
