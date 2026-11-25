import type { Order, Policy } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import {
  climb,
  confirmed,
  fillFloor,
  hits,
  placeReasons,
  step,
  triggerOf,
} from '../src/domain/orders.js'
import { basePolicy } from './harness.js'
import { BONK, trading } from './venue.js'

const policy = (orders = { enabled: true, maxOpen: 2 }): Policy => ({
  agentId: 'agent-1',
  ...basePolicy,
  trading: { ...trading, orders },
})
const open = (amount: string, token = BONK) => ({ token, amount }) as Order
const order = { token: BONK, amount: '40', maxSlippageBps: 100 }

describe('placing orders (CR-026)', () => {
  it('places an order within the position, the open count and the slippage limit', () => {
    expect(placeReasons(policy(), order, [open('60')], 100n)).toEqual([])
  })

  it('refuses when orders or trading are off', () => {
    expect(placeReasons(policy({ enabled: false, maxOpen: 2 }), order, [], 100n)).toEqual([
      'ORDERS_DISABLED',
    ])
    const off = { ...policy(), trading: { ...trading, enabled: false } }
    expect(placeReasons(off, order, [], 100n)).toEqual(['TRADING_DISABLED'])
  })

  it('refuses more open orders than allowed, more than the position, or more slippage', () => {
    expect(placeReasons(policy(), order, [open('1', 'X'), open('1', 'Y')], 100n)).toEqual([
      'ORDER_LIMIT_EXCEEDED',
    ])
    expect(placeReasons(policy(), order, [open('61')], 100n)).toEqual(['INSUFFICIENT_POSITION'])
    expect(placeReasons(policy(), order, [open('61')], undefined)).toEqual([])
    expect(placeReasons(policy(), { ...order, maxSlippageBps: 101 }, [], 100n)).toEqual([
      'SLIPPAGE_TOO_HIGH',
    ])
  })
})

describe('the order watcher rules (CR-026)', () => {
  it('fires a take-profit at or above its price, a stop-loss at or below it', () => {
    const at = (kind: Order['kind']) => ({ kind, triggerOut: '10' })
    expect(hits(at('take_profit'), 10n)).toBe(true)
    expect(hits(at('take_profit'), 9n)).toBe(false)
    expect(hits(at('stop_loss'), 10n)).toBe(true)
    expect(hits(at('stop_loss'), 11n)).toBe(false)
  })

  it('counts unbroken hits, and starts over on a miss, a high-impact check or a gap', () => {
    const at = (ms: number, priceImpactBps = 10) => ({ hit: true, priceImpactBps, at: ms })
    const first = step(undefined, at(0), 300, 30_000)
    expect(first).toEqual({ checks: 1, since: 0, last: 0 })
    const second = step(first, at(15_000), 300, 30_000)
    expect(second).toEqual({ checks: 2, since: 0, last: 15_000 })
    expect(step(second, at(20_000, 301), 300, 30_000)).toBeUndefined()
    expect(step(second, { ...at(30_000), hit: false }, 300, 30_000)).toBeUndefined()
    expect(step(second, at(45_001), 300, 30_000)).toEqual({
      checks: 1,
      since: 45_001,
      last: 45_001,
    })
  })

  it('confirms only enough hits over long enough', () => {
    const rules = { confirmChecks: 3, confirmSeconds: 30 }
    expect(confirmed({ checks: 3, since: 0, last: 0 }, 30_000, rules)).toBe(true)
    expect(confirmed({ checks: 3, since: 0, last: 0 }, 29_999, rules)).toBe(false)
    expect(confirmed({ checks: 2, since: 0, last: 0 }, 60_000, rules)).toBe(false)
    expect(confirmed(undefined, 60_000, rules)).toBe(false)
  })

  it('fills for no less than the trigger less its slippage, rounded down', () => {
    expect(fillFloor({ kind: 'stop_loss', triggerOut: '1001', maxSlippageBps: 100 })).toBe(990n)
  })
})

describe('trailing stops (CR-028)', () => {
  const trail = (peakOut?: string, triggerOut = '0') =>
    ({
      kind: 'trailing_stop',
      triggerOut,
      trailBps: 1000,
      maxSlippageBps: 100,
      ...(peakOut === undefined ? {} : { peakOut }),
    }) as const

  it('fires 10% under its confirmed high, never under its floor, and not at all with neither', () => {
    expect(triggerOf(trail('1000'))).toBe(900n)
    expect(triggerOf(trail('1000', '950'))).toBe(950n)
    expect(triggerOf(trail(undefined, '500'))).toBe(500n)
    expect(hits(trail('1000'), 900n)).toBe(true)
    expect(hits(trail('1000'), 901n)).toBe(false)
    expect(hits(trail(), 0n)).toBe(false)
    expect(fillFloor(trail('1000'))).toBe(891n)
  })

  const rules = { confirmChecks: 3, confirmSeconds: 30, maxImpactBps: 300, maxGapMs: 30_000 }
  const run = (outs: [number, number, number?][]) =>
    outs.reduce<{ rise: { out: bigint; at: number }[]; level?: bigint }>(
      (acc, [out, at, impact]) =>
        climb(acc.rise, { out: BigInt(out), at, priceImpactBps: impact ?? 10 }, rules),
      { rise: [] },
    )

  it('raises the high to the lowest quote of a confirming run', () => {
    expect(
      run([
        [1000, 0],
        [1200, 15_000],
        [1100, 30_000],
      ]).level,
    ).toBe(1000n)
    expect(
      run([
        [1000, 0],
        [1200, 15_000],
        [1100, 30_000],
        [1300, 45_000],
      ]).level,
    ).toBe(1100n)
  })

  it('is never moved by one spiked quote, a short run, a high-impact check or a gap', () => {
    expect(
      run([
        [1000, 0],
        [9999, 15_000],
        [1000, 30_000],
      ]).level,
    ).toBe(1000n)
    expect(
      run([
        [1000, 0],
        [1000, 15_000],
      ]).level,
    ).toBeUndefined()
    expect(
      run([
        [1000, 0],
        [1000, 10_000],
        [1000, 20_000],
      ]).level,
    ).toBeUndefined()
    expect(
      run([
        [1000, 0],
        [1000, 15_000, 301],
        [1000, 30_000],
      ]).level,
    ).toBeUndefined()
    expect(
      run([
        [1000, 0],
        [1000, 15_000],
        [1000, 45_001],
      ]).level,
    ).toBeUndefined()
  })
})
