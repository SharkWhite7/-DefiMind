import { describe, expect, it } from 'vitest'
import { getOrder, saveOrder } from '../src/db/orders.js'
import * as repo from '../src/db/repo.js'
import {
  disableAll,
  endInterrupted,
  listTicks,
  saveTick,
  setPaused,
  traderToday,
} from '../src/db/traders.js'
import { WSOL } from '../src/domain/valuation.js'
import { placeOrder } from '../src/service/orders.js'
import { CHAIN, NOW } from './harness.js'
import { buy, setup } from './trader-setup.js'
import { BONK } from './venue.js'

const stopped = 'stopped: the trader or its agent was paused, turned off or killed'

describe('a tick that the owner stops (CR-027 review)', () => {
  const stops = {
    Close: (db: Parameters<typeof disableAll>[0]) => disableAll(db, NOW),
    'a trader pause': (db: Parameters<typeof disableAll>[0]) =>
      setPaused(db, 'agent-1', 'owner', NOW),
    'a kill': (db: Parameters<typeof disableAll>[0]) =>
      repo.setPaused(db, 'agent-1', true, NOW.toISOString()),
  }
  for (const [name, stop] of Object.entries(stops)) {
    it(`acts on nothing after ${name} lands mid-tick`, async () => {
      const { h, fake, tick } = await setup([{ tools: [buy()] }, { tools: [buy()] }])
      fake.hooks.before = (i) => (i === 1 ? stop(h.db) : undefined)
      const done = await tick()
      expect(done?.actions).toHaveLength(1)
      expect(done?.detail).toBe(stopped)
      expect(fake.sent).toHaveLength(2)
    })
  }

  it('re-checks inside the wallet lock: a swap queued behind Close does not buy back', async () => {
    const { h, t, tick } = await setup([{ tools: [buy()] }])
    let release = () => {}
    const gate = new Promise<void>((done) => (release = done))
    // Close holds the shared wallet's lock while the trader's swap queues behind it.
    const close = t.deps.serial(`wallet:shared:${CHAIN}`, async () => {
      await gate
      disableAll(h.db, NOW)
    })
    const running = tick()
    await new Promise((done) => setTimeout(done, 50))
    release()
    await close
    const done = await running
    expect(done?.actions[0]).toMatchObject({ status: 'rejected', rejectReasons: ['PAUSED'] })
  })

  it('places no order for a paused agent, whoever asks', async () => {
    const { h, t } = await setup()
    repo.setPaused(h.db, 'agent-1', true, NOW.toISOString())
    const order = {
      agentId: 'agent-1',
      chain: CHAIN,
      token: BONK,
      kind: 'stop_loss' as const,
      amount: '1',
      triggerOut: '1',
    }
    expect(placeOrder(t.deps, order, 'owner')).toEqual(['PAUSED'])
  })
})

describe("the trader's own limits (CR-027 review)", () => {
  it("never cancels the owner's orders, nor real orders from a shadow tick on a live agent", async () => {
    const order = (id: string, createdBy: 'agent' | 'owner') => ({
      id,
      agentId: 'agent-1',
      chain: CHAIN,
      token: BONK,
      kind: 'stop_loss' as const,
      amount: '1',
      triggerOut: '1',
      maxSlippageBps: 100,
      createdBy,
      status: 'open' as const,
      createdAt: NOW.toISOString(),
    })
    const cancel = (orderId: string) => ({ name: 'cancel_order', input: { orderId } })
    const { h, tick } = await setup([{ tools: [cancel('mine'), cancel('owners')] }])
    saveOrder(h.db, order('mine', 'agent'))
    saveOrder(h.db, order('owners', 'owner'))
    const done = await tick()
    expect(done?.actions.map((a) => a.rejectReasons)).toEqual([['ORDERS_DISABLED'], []])
    expect(getOrder(h.db, 'mine')?.status).toBe('open')
    expect(getOrder(h.db, 'owners')?.status).toBe('open')
  })

  it("caps a tick at what is left of the day's tokens", async () => {
    // Each scripted answer spends 3,100 tokens.
    const { h, tick } = await setup([{ text: 'Quiet.' }, { tools: [buy()] }], {
      maxTokensPerDay: 4000,
    })
    await tick()
    h.clock.now = new Date(NOW.getTime() + 3_600_000)
    expect(await tick()).toMatchObject({ actions: [], detail: 'maxTokensPerDay reached' })
  })

  it('answers at most 8 reads per response', async () => {
    const read = { name: 'get_portfolio', input: {} }
    const { fake, tick } = await setup([{ tools: Array.from({ length: 9 }, () => read) }])
    await tick()
    const results = JSON.stringify(fake.sent[1]?.body['messages'])
    expect(results.match(/at most 8 reads per turn/g)).toHaveLength(1)
  })

  it('takes "SOL" as the wrapped SOL mint', async () => {
    const sell = { name: 'swap', input: { from: 'SOL', to: 'USDC', amount: '1000', reason: 'x' } }
    const { h, tick } = await setup([{ tools: [sell] }])
    const done = await tick()
    expect(repo.getIntent(h.db, done?.actions[0]?.intentId ?? '')?.token).toBe(WSOL)
  })
})

describe('a tick through a crash (CR-027 review)', () => {
  it('is saved as it runs, so its tokens count before it ends', async () => {
    const { h, fake, tick } = await setup([{ tools: [buy()] }, { text: 'Done.' }])
    let seen = { ticks: 0, tokens: 0 }
    fake.hooks.before = (i) => {
      if (i === 1) {
        seen = traderToday(h.db, 'agent-1', '2026-11-03')
      }
    }
    await tick()
    expect(seen.tokens).toBe(3100)
    expect(listTicks(h.db, 'agent-1')).toHaveLength(1)
  })

  it('ends a tick left running as an error, and is not shown until then', async () => {
    const { h } = await setup()
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
    const tick = { id: 'crashed', agentId: 'agent-1', startedAt: NOW.toISOString(), model: 'm' }
    saveTick(h.db, { ...tick, outcome: 'held', actions: [], reason: '', usage }, '2026-11-03', true)
    expect(listTicks(h.db, 'agent-1')).toHaveLength(0)
    expect(endInterrupted(h.db)).toBe(1)
    expect(listTicks(h.db, 'agent-1')[0]).toMatchObject({
      outcome: 'error',
      detail: 'interrupted by a restart',
    })
  })
})
