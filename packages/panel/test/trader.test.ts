import { describe, expect, it } from 'vitest'
import { formatUsd } from '../src/domain/money.js'
import {
  defaultConfig,
  fromTraderForm,
  signedUsd,
  type TraderConfig,
  traderLoosens,
} from '../src/domain/trader.js'

const on: TraderConfig = { ...defaultConfig(), enabled: true, tokens: ['m'], instructions: 'x' }

describe('the AI trader', () => {
  it('needs the passkey for anything but turning off or lowering a cap', () => {
    expect(traderLoosens(undefined, on)).toBe(true)
    expect(traderLoosens(on, { ...on, mode: 'live' })).toBe(true)
    expect(traderLoosens(on, { ...on, instructions: 'y' })).toBe(true)
    expect(traderLoosens(on, { ...on, tokens: ['m', 'n'] })).toBe(true)
    expect(traderLoosens(on, { ...on, model: 'claude-haiku-5-5' })).toBe(true)
    expect(traderLoosens(on, { ...on, maxActionsPerTick: 4 })).toBe(true)
    expect(traderLoosens(on, { ...on, template: { id: 'a', version: 1 } })).toBe(true)
  })

  it('lets turning off and lowering caps through without it', () => {
    expect(traderLoosens(on, on)).toBe(false)
    expect(traderLoosens(on, { ...on, enabled: false })).toBe(false)
    expect(
      traderLoosens(on, { ...on, enabled: false, maxActionsPerTick: 1, maxTokensPerDay: 10 }),
    ).toBe(false)
    expect(traderLoosens(undefined, defaultConfig())).toBe(false)
  })

  it('reads the form, and says what is wrong', () => {
    const form = { instructions: ' Hold. ', tokens: 'a\nb a', maxActionsPerTick: '2' }
    expect(fromTraderForm(on, form)).toMatchObject({
      instructions: 'Hold.',
      tokens: ['a', 'b'],
      maxActionsPerTick: 2,
    })
    expect(fromTraderForm(on, { ...form, instructions: '' })).toMatch(/^Instructions: write/)
    expect(fromTraderForm(on, { ...form, instructions: 'x'.repeat(2001) })).toBe(
      'Instructions: at most 2000 characters (now 2001).',
    )
    expect(fromTraderForm(on, { ...form, tokens: '' })).toMatch(/^Tokens:/)
    expect(fromTraderForm(on, { ...form, maxActionsPerTick: '6' })).toMatch(/1 to 5/)
  })

  it('signs a realized result, zero unsigned', () => {
    expect(signedUsd('-1250000', formatUsd)).toBe('-$1.25')
    expect(signedUsd('3000000', formatUsd)).toBe('+$3.00')
    expect(signedUsd('0', formatUsd)).toBe('$0.00')
  })
})
