import { describe, expect, it } from 'vitest'
import {
  fromLimitsForm,
  type Limits,
  limitedMints,
  limitsLoosen,
  toLimitsForm,
  withLimits,
} from '../src/domain/limits.js'
import { NO_TRADING, tradingLoosens } from '../src/domain/trading.js'

const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const set: Limits = {
  tokenLimits: { [MINT]: { maxBuyUsd: '5000000', maxHeldUsd: '20000000' } },
  operations: { sell: { maxTradeUsd: '10000000', dailyMax: '50000000' } },
  orders: { enabled: true, maxOpen: 5 },
}

describe('CR-026 limits', () => {
  it('counts a limit added, raised or removed, and orders opened up, as loosening', () => {
    expect(limitsLoosen({}, { tokenLimits: { [MINT]: { maxBuyUsd: '1' } } })).toBe(true)
    expect(
      limitsLoosen(set, {
        ...set,
        tokenLimits: { [MINT]: { maxBuyUsd: '5000001', maxHeldUsd: '20000000' } },
      }),
    ).toBe(true)
    expect(limitsLoosen(set, { ...set, tokenLimits: {} })).toBe(true)
    expect(limitsLoosen(set, { ...set, operations: {} })).toBe(true)
    expect(limitsLoosen({}, { orders: { enabled: true, maxOpen: 10 } })).toBe(true)
    expect(limitsLoosen(set, { ...set, orders: { enabled: true, maxOpen: 6 } })).toBe(true)
  })

  it('lets the same or tighter through without a passkey', () => {
    expect(limitsLoosen(set, set)).toBe(false)
    expect(limitsLoosen({}, { orders: { enabled: false, maxOpen: 10 } })).toBe(false)
    const tighter: Limits = {
      tokenLimits: { [MINT]: { maxBuyUsd: '1000000', maxHeldUsd: '20000000' } },
      operations: { sell: { maxTradeUsd: '1', dailyMax: '2' } },
      orders: { enabled: false, maxOpen: 1 },
    }
    expect(limitsLoosen(set, tighter)).toBe(false)
  })

  it('is part of tradingLoosens', () => {
    const on = { ...NO_TRADING, enabled: true }
    expect(tradingLoosens(on, { ...on, ...set })).toBe(true)
    expect(tradingLoosens({ ...on, ...set }, { ...on, ...set })).toBe(false)
  })

  it('shows dollars and empty defaults, and reads them back unchanged', () => {
    const form = toLimitsForm(set, [MINT])
    expect(form.tokens[MINT]).toEqual({ maxBuy: '5.00', maxHeld: '20.00' })
    expect(form.operations.buy).toEqual({ trade: '', daily: '' })
    expect(form.maxOpen).toBe('5')
    expect(fromLimitsForm(form)).toEqual(set)
  })

  it('drops empty fields, and a comma is a decimal point', () => {
    const form = toLimitsForm({}, [MINT])
    form.operations.swap = { trade: '2,50', daily: '10' }
    expect(fromLimitsForm(form)).toEqual({
      operations: { swap: { maxTradeUsd: '2500000', dailyMax: '10000000' } },
      orders: { enabled: false, maxOpen: 10 },
    })
  })

  it('says what is wrong instead', () => {
    const form = toLimitsForm({}, [MINT])
    expect(
      fromLimitsForm({
        ...form,
        operations: { ...form.operations, sell: { trade: '5', daily: '' } },
      }),
    ).toBe('Sells: write both, per trade and per day, or leave both empty.')
    expect(fromLimitsForm({ ...form, tokens: { [MINT]: { maxBuy: 'lots', maxHeld: '' } } })).toBe(
      `${MINT}: write an amount in dollars, like 5.00, or leave it empty.`,
    )
    expect(fromLimitsForm({ ...form, maxOpen: '2.5' })).toBe(
      'Open orders: write a whole number, like 10.',
    )
  })

  it('lists every mint with a limit, allowed or not, so none is dropped unseen', () => {
    const other = 'B'.repeat(44)
    expect(limitedMints({ tokenLimits: { [other]: { maxBuyUsd: '1' } } }, [MINT])).toEqual([
      MINT,
      other,
    ])
  })

  it('replaces the old limits, an emptied one removed', () => {
    const trading = { ...NO_TRADING, ...set }
    const after = withLimits(trading, { orders: { enabled: false, maxOpen: 10 } })
    expect(after.tokenLimits).toBeUndefined()
    expect(after.operations).toBeUndefined()
    expect(after.maxTradeUsd).toBe('0')
  })
})

describe('CR-028 protection', () => {
  it('counts the shield turned off and quick first buys set or raised as loosening', () => {
    expect(limitsLoosen({}, { rugShield: { enabled: false } })).toBe(true)
    expect(limitsLoosen({ rugShield: { enabled: false } }, {})).toBe(false)
    const quick = (maxUsd: string) => ({ quickFirstBuy: { maxUsd, dailyUsd: '9000000' } })
    expect(limitsLoosen({}, quick('1000000'))).toBe(true)
    expect(limitsLoosen(quick('1000000'), quick('2000000'))).toBe(true)
    expect(limitsLoosen(quick('2000000'), quick('1000000'))).toBe(false)
    expect(limitsLoosen(quick('2000000'), {})).toBe(false)
  })

  it('reads quick first buys and the shield from the form, both amounts or neither', () => {
    const form = toLimitsForm({}, [MINT])
    expect(form.shield).toBe(true)
    form.shield = false
    form.quickBuy = '3'
    form.quickDay = '10'
    expect(fromLimitsForm(form)).toMatchObject({
      rugShield: { enabled: false },
      quickFirstBuy: { maxUsd: '3000000', dailyUsd: '10000000' },
    })
    form.quickDay = ''
    expect(fromLimitsForm(form)).toBe(
      'Quick first buys: write both amounts in dollars, or leave both empty to turn them off.',
    )
  })
})
