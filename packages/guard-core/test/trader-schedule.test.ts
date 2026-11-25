import { describe, expect, it } from 'vitest'
import { recentPrices } from '../src/db/prices.js'
import { priceSamples } from '../src/db/trader-schema.js'
import { getTrader, listTicks, saveTrader } from '../src/db/traders.js'
import { DEFAULT_TRADER } from '../src/domain/trader.js'
import type { X402Deps } from '../src/service/x402.js'
import { serial } from '../src/service/serial.js'
import { dueTicks, samplePrices } from '../src/service/trader-schedule.js'
import { fakeClaude } from './claude-fake.js'
import { CHAIN, harness, MINT as USDC, NOW } from './harness.js'
import { signedIn } from './owner.js'
import { BONK, trading, Venue } from './venue.js'

async function setup() {
  const chain = new Venue()
  const h = await harness({ chain, policy: { trading } })
  const config = { ...DEFAULT_TRADER, enabled: true, tokens: [BONK], cadenceMinutes: 15 as const }
  saveTrader(h.db, 'agent-1', config, NOW)
  const deps = {
    db: h.db,
    chains: new Map([[CHAIN, chain]]),
    usdc: new Map([[CHAIN, USDC]]),
    bot: h.bot,
    now: () => h.clock.now,
    serial: serial(),
    log: { warn: () => {}, error: () => {} },
  } as unknown as X402Deps
  const fake = fakeClaude()
  return { h, t: { deps, claude: fake.claude, search: async () => [] }, fake }
}

const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

describe('the trader schedule (CR-027)', () => {
  it('runs a trader once per cadence, counted from its last tick', async () => {
    const { h, t, fake } = await setup()
    await dueTicks(t)
    h.clock.now = later(14)
    await dueTicks(t)
    expect(fake.sent).toHaveLength(1)
    h.clock.now = later(15)
    await dueTicks(t)
    expect(listTicks(h.db, 'agent-1')).toHaveLength(2)
  })

  it('samples the price of each listed token, and keeps a week of them', async () => {
    const { h, t } = await setup()
    await samplePrices(t)
    const [sample] = recentPrices(h.db, CHAIN, BONK, NOW)
    expect(sample).toMatchObject({ at: NOW.toISOString(), priceUsd: expect.any(String) })
    h.clock.now = later(8 * 24 * 60)
    await samplePrices(t)
    const kept = h.db
      .select()
      .from(priceSamples)
      .all()
      .map((s) => s.at)
    expect(kept).toEqual([h.clock.now.toISOString()])
  })

  it('is paused by kill and turned off by Close', async () => {
    const { h } = await setup()
    const owner = await signedIn(h)
    await owner.call('POST', '/v1/owner/kill')
    expect(getTrader(h.db, 'agent-1')?.pausedBy).toBe('kill')
    await owner.call('POST', '/v1/owner/positions/close', {
      assertion: await owner.stepUp('close_positions', {}),
    })
    expect(getTrader(h.db, 'agent-1')?.config.enabled).toBe(false)
  })
})
