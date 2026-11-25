import { describe, expect, it } from 'vitest'
import { belowGasReserve, swapValue, WSOL } from '../src/domain/valuation.js'

const NOW = new Date('2026-11-25T12:00:00Z')
const leg = (out: string, priceImpactBps = 10, ageMs = 1_000) => ({
  out,
  priceImpactBps,
  quotedAt: new Date(NOW.getTime() - ageMs).toISOString(),
})

describe('swap valuation (CR-026)', () => {
  it('takes the higher leg, so a leg priced low cannot carry a trade past a limit', () => {
    expect(swapValue([leg('900'), leg('1000')], 300, NOW)).toBe(1000n)
  })

  it('values nothing when a leg is stale, from the future, or moves the price too far', () => {
    expect(swapValue([leg('1'), leg('2', 10, 30_001)], 300, NOW)).toBeUndefined()
    expect(swapValue([leg('1'), leg('2', 10, -1)], 300, NOW)).toBeUndefined()
    expect(swapValue([leg('1', 301), leg('2')], 300, NOW)).toBeUndefined()
    expect(swapValue([], 300, NOW)).toBeUndefined()
  })
})

describe('the gas reserve (CR-026)', () => {
  const gas = { balance: '10', minimum: '4' }

  it('counts SOL spent by the trade against what the next sell needs', () => {
    expect(belowGasReserve(gas, WSOL, '6')).toBe(false)
    expect(belowGasReserve(gas, WSOL, '7')).toBe(true)
    expect(belowGasReserve(gas, 'Bonk', '7')).toBe(false)
    expect(belowGasReserve({ balance: '3', minimum: '4' }, 'Bonk', '1')).toBe(true)
  })
})
