import { describe, expect, it } from 'vitest'
import {
  clip,
  DEFAULT_TRADER,
  nextStreak,
  skipReason,
  tokensOf,
  traderNeedsPasskey,
  traderState,
  unitPrice,
} from '../src/domain/trader.js'

const on = { ...DEFAULT_TRADER, enabled: true, instructions: 'Hold.', tokens: ['mint'] }

describe('the trader passkey rule (CR-027)', () => {
  it('lets the owner turn it off or lower caps without it', () => {
    expect(traderNeedsPasskey(on, { ...on, enabled: false })).toBe(false)
    expect(traderNeedsPasskey(on, { ...on, maxActionsPerTick: 1, maxTokensPerDay: 10 })).toBe(false)
    expect(traderNeedsPasskey(on, on)).toBe(false)
  })

  it('needs it for anything else', () => {
    expect(traderNeedsPasskey(DEFAULT_TRADER, on)).toBe(true)
    expect(traderNeedsPasskey(on, { ...on, maxTicksPerDay: 97 })).toBe(true)
    expect(traderNeedsPasskey(on, { ...on, tokens: [] })).toBe(true)
    expect(traderNeedsPasskey(on, { ...on, mode: 'live' })).toBe(true)
    expect(traderNeedsPasskey(on, { ...on, template: { id: 'trend-stops', version: 1 } })).toBe(
      true,
    )
  })
})

describe('the trader caps and streaks', () => {
  it('skips a tick once the day is spent', () => {
    expect(skipReason(on, { ticks: 0, tokens: 0 })).toBeUndefined()
    expect(skipReason(on, { ticks: 96, tokens: 0 })).toBe('maxTicksPerDay reached')
    expect(skipReason(on, { ticks: 1, tokens: 2_000_000 })).toBe('maxTokensPerDay reached')
  })

  it('pauses after three errors, or three refusals, in a row', () => {
    let streak = nextStreak({ kind: null, count: 0 }, 'error')
    streak = nextStreak(streak, 'error')
    expect(streak.pause).toBeUndefined()
    expect(nextStreak(streak, 'error')).toMatchObject({ count: 3, pause: 'errors' })
    expect(nextStreak(streak, 'refused')).toEqual({ kind: 'refused', count: 1 })
    expect(nextStreak(streak, 'held')).toEqual({ kind: null, count: 0 })
    const refused = { kind: 'refused' as const, count: 2 }
    expect(nextStreak(refused, 'refused').pause).toBe('refusals')
  })

  it('reads its state and bounds the model text', () => {
    expect(traderState(DEFAULT_TRADER, 'owner', false)).toEqual({ state: 'off' })
    expect(traderState(on, null, true)).toEqual({ state: 'paused', pausedBy: 'agent_paused' })
    expect(traderState(on, 'kill', true)).toEqual({ state: 'paused', pausedBy: 'kill' })
    expect(traderState(on, null, false)).toEqual({ state: 'running' })
    expect(clip('x'.repeat(600))).toHaveLength(500)
    expect(clip('short')).toBe('short')
    expect(tokensOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10)
  })
})

describe('unitPrice', () => {
  it('prices one whole token from a sell quote', () => {
    expect(unitPrice(10_000_000n, 10_000_000_000n, 5)).toBe('0.0001')
    expect(unitPrice(9_990_000n, 4_000_000_000n, 9)).toBe('2.4975')
    expect(unitPrice(10_000_000n, 3_000_000_000_000_000n, 5)).toBe('0.000000000333')
    expect(unitPrice(1n, 0n, 6)).toBe('0')
  })
})
