import { describe, expect, it } from 'vitest'
import { TRADER_TEMPLATES } from '../src/trader-templates.js'

describe('ready-made trader strategies (CR-027)', () => {
  it('have unique ids and fit the instructions limit', () => {
    expect(new Set(TRADER_TEMPLATES.map((t) => t.id)).size).toBe(TRADER_TEMPLATES.length)
    for (const t of TRADER_TEMPLATES) expect(t.instructions.length).toBeLessThanOrEqual(2000)
  })

  it('claim no performance', () => {
    const claims = /\b(tested|proven|guarantee\w*|profit\w*|returns?|safe)\b/i
    for (const t of TRADER_TEMPLATES) {
      // "take-profit" names an order kind, not a claim.
      const text = `${t.name} ${t.summary} ${t.instructions}`.replaceAll('take-profit', '')
      expect(text).not.toMatch(claims)
    }
  })

  it('suggest limits within the beta daily cap', () => {
    for (const { suggested } of TRADER_TEMPLATES) {
      expect(BigInt(suggested.maxTradeUsd)).toBeLessThanOrEqual(BigInt(suggested.dailyTradeMax))
      expect(BigInt(suggested.dailyTradeMax)).toBeLessThanOrEqual(50_000_000n)
    }
  })
})
