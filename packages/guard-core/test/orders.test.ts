import { describe, expect, it } from 'vitest'
import { getOrder } from '../src/db/orders.js'
import { applyTrade, getPosition } from '../src/db/trades.js'
import { orderWatcher } from '../src/service/order-watcher.js'
import type { PaymentDeps } from '../src/service/payments.js'
import { serial } from '../src/service/serial.js'
import { CHAIN, harness, MINT as USDC, NOW } from './harness.js'
import { signedIn } from './owner.js'
import { BONK, trading, Venue } from './venue.js'

const RULES = { confirmChecks: 3, confirmSeconds: 30 }

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

  it('never sells a stop-loss below its floor: the order fails and the position stays', async () => {
    const { h, run } = await setup()
    const order = (
      await h.agent('POST', '/v1/agent/orders', place({ kind: 'stop_loss', triggerOut: '2000' }))
    ).json()
    await run()
    await run()
    expect(getOrder(h.db, order.id)).toMatchObject({
      status: 'failed',
      failReason: 'SLIPPAGE_TOO_HIGH',
    })
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK).amount).toBe(2_000_000n)
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
