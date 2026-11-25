import { describe, expect, it } from 'vitest'
import { getPosition, applyTrade } from '../src/db/trades.js'
import { newRisk, shieldFloor } from '../src/domain/shield.js'
import type { PaymentDeps } from '../src/service/payments.js'
import { rugShield } from '../src/service/rug-shield.js'
import { serial } from '../src/service/serial.js'
import { CHAIN, harness, MINT as USDC, NOW } from './harness.js'
import { signedIn } from './owner.js'
import { BONK, trading, Venue } from './venue.js'

const RULES = {
  checkMs: 60_000,
  confirmChecks: 3,
  supplyJumpBps: 1000,
  maxLossBps: 5000,
  dustUsd: 1_000n,
}

/** An agent holding 2,000,000 BONK, worth 2000 atomic USDC at the venue: above the test's dust. */
async function setup(over: object = {}) {
  const chain = new Venue()
  const h = await harness({ chain, policy: { trading, ...over } })
  chain.held.set(BONK, 2_000_000n)
  chain.clock = () => h.clock.now
  const trade = { agentId: 'agent-1', chain: CHAIN, token: BONK, decimals: 5 }
  applyTrade(h.db, { ...trade, side: 'buy', amount: 2_000_000n, cost: 2_000_000n }, NOW)
  const deps: PaymentDeps = {
    db: h.db,
    chains: new Map([[CHAIN, chain]]),
    usdc: new Map([[CHAIN, USDC]]),
    bot: h.bot,
    now: () => h.clock.now,
    serial: serial(),
    log: { warn: () => {}, error: () => {} },
  }
  const shield = rugShield(deps, RULES)
  const tick = async (times = 1) => {
    for (let i = 0; i < times; i++) {
      await shield.tick()
      h.clock.now = new Date(h.clock.now.getTime() + 60_000)
    }
  }
  const held = () => getPosition(h.db, 'agent-1', CHAIN, BONK).amount
  return { h, chain, tick, held }
}

describe('the rug shield rules (CR-028)', () => {
  const base = { freezeAuthority: false, mintAuthority: true, extensions: [], supply: '1000' }

  it('names a risk that appeared since the buy, never one the token always had', () => {
    expect(newRisk(base, { ...base, freezeAuthority: true }, 1000)).toBe(
      'the mint gained a freeze authority',
    )
    expect(newRisk(base, { ...base, extensions: ['TransferHook'] }, 1000)).toBe(
      'the mint gained TransferHook',
    )
    expect(newRisk(base, { ...base, supply: '1101' }, 1000)).toBe('the supply was inflated')
    expect(newRisk(base, { ...base, supply: '1100' }, 1000)).toBeUndefined()
    const always = { ...base, freezeAuthority: true, extensions: ['TransferHook'] }
    expect(newRisk(always, always, 1000)).toBeUndefined()
    expect(
      newRisk(
        { ...base, mintAuthority: false },
        { ...base, mintAuthority: false, supply: '9999' },
        1000,
      ),
    ).toBeUndefined()
  })

  it('floors a liquidity sell at half the last good quote, never under the market less slippage', () => {
    expect(shieldFloor(900n, 100, 1000n, 5000)).toBe(891n)
    expect(shieldFloor(100n, 100, 1000n, 5000)).toBe(500n)
    expect(shieldFloor(100n, 100, undefined, 5000)).toBe(99n)
  })
})

describe('the rug shield watcher (CR-028)', () => {
  it('sells the whole position when a new risk shows on two checks in a row', async () => {
    const { h, chain, tick, held } = await setup()
    await tick()
    chain.mint.freezeAuthority = true
    await tick()
    expect(held()).toBe(2_000_000n)
    await tick()
    expect(held()).toBe(0n)
    expect(h.auditEvents()).toContain('rug_shield')
  })

  it('never sells on one bad read', async () => {
    const { chain, tick, held } = await setup()
    await tick()
    chain.mint.freezeAuthority = true
    await tick()
    chain.mint.freezeAuthority = false
    await tick(3)
    expect(held()).toBe(2_000_000n)
  })

  it('sells when the liquidity goes for a whole run after a good check, and not before one', async () => {
    const gone = await setup()
    await gone.tick()
    gone.chain.sellImpactBps = 5000
    await gone.tick(2)
    expect(gone.held()).toBe(2_000_000n)
    await gone.tick()
    expect(gone.held()).toBe(0n)

    const never = await setup()
    never.chain.sellImpactBps = 5000
    await never.tick(6)
    expect(never.held()).toBe(2_000_000n)
  })

  it('only tells the owner, once, when the agent is paused, and does nothing when it is off', async () => {
    const paused = await setup()
    await paused.tick()
    await (await signedIn(paused.h)).call('POST', '/v1/owner/pause', { agentId: 'agent-1' })
    paused.chain.mint.freezeAuthority = true
    await paused.tick(4)
    expect(paused.held()).toBe(2_000_000n)
    expect(paused.h.auditEvents().filter((e) => e === 'rug_shield')).toHaveLength(1)

    const off = await setup({ trading: { ...trading, rugShield: { enabled: false } } })
    await off.tick()
    off.chain.mint.freezeAuthority = true
    await off.tick(3)
    expect(off.held()).toBe(2_000_000n)
    expect(off.h.auditEvents()).not.toContain('rug_shield')
  })

  it('skips a position worth less than the dust floor', async () => {
    const { chain, tick, held } = await setup()
    chain.sellOut = '999'
    await tick()
    chain.mint.freezeAuthority = true
    await tick(3)
    expect(held()).toBe(2_000_000n)
  })

  it('compares supply with the baseline, so slow inflation adds up', async () => {
    const { chain, tick, held } = await setup()
    chain.mint.mintAuthority = true
    await tick()
    for (const supply of ['1060000', '1120000', '1120000']) {
      chain.mint.supply = supply
      await tick()
    }
    expect(held()).toBe(0n)
  })
})
