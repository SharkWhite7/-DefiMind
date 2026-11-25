import type { Order, Policy } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { confirmed, fillFloor, hits, placeReasons, step } from '../src/domain/orders.js'
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
    expect(hits('take_profit', 10n, 10n)).toBe(true)
    expect(hits('take_profit', 9n, 10n)).toBe(false)
    expect(hits('stop_loss', 10n, 10n)).toBe(true)
    expect(hits('stop_loss', 11n, 10n)).toBe(false)
  })

  it('counts consecutive hits, starts over on a miss, and ignores a check that moves the price', () => {
    const first = step(undefined, { hit: true, priceImpactBps: 10, at: 0 }, 300)
    expect(first).toEqual({ checks: 1, since: 0 })
    const second = step(first, { hit: true, priceImpactBps: 10, at: 15_000 }, 300)
    expect(second).toEqual({ checks: 2, since: 0 })
    expect(step(second, { hit: true, priceImpactBps: 301, at: 20_000 }, 300)).toBe(second)
    expect(step(second, { hit: false, priceImpactBps: 10, at: 30_000 }, 300)).toBeUndefined()
  })

  it('confirms only enough hits over long enough', () => {
    const rules = { confirmChecks: 3, confirmSeconds: 30 }
    expect(confirmed({ checks: 3, since: 0 }, 30_000, rules)).toBe(true)
    expect(confirmed({ checks: 3, since: 0 }, 29_999, rules)).toBe(false)
    expect(confirmed({ checks: 2, since: 0 }, 60_000, rules)).toBe(false)
    expect(confirmed(undefined, 60_000, rules)).toBe(false)
  })

  it('fills for no less than the trigger less its slippage, rounded down', () => {
    expect(fillFloor({ triggerOut: '1001', maxSlippageBps: 100 })).toBe(990n)
  })
})
