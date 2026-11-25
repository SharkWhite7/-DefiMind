import { describe, expect, it } from 'vitest'
import { fromOrderForm, orderFloor } from '../src/domain/orders.js'

const form = { kind: 'stop_loss', amount: '1.5', trigger: '40', slippage: '' }

describe('orders (CR-026)', () => {
  it('works out the floor as guard-core does, rounded down', () => {
    expect(orderFloor('40000000', 100)).toBe('39600000')
    expect(orderFloor('3', 5000)).toBe('1')
    expect(orderFloor('40000000', 0)).toBe('40000000')
  })

  it("sends the agent's own slippage when the owner left it empty", () => {
    expect(fromOrderForm(form, 6, 100)).toEqual({
      kind: 'stop_loss',
      amount: '1500000',
      triggerOut: '40000000',
      maxSlippageBps: 100,
    })
    expect(fromOrderForm({ ...form, slippage: '0,5' }, 6, 100)).toEqual({
      kind: 'stop_loss',
      amount: '1500000',
      triggerOut: '40000000',
      maxSlippageBps: 50,
    })
  })

  it('says the first thing wrong', () => {
    expect(fromOrderForm({ ...form, kind: 'market' }, 6, 100)).toBe(
      'Choose take profit or stop loss.',
    )
    expect(fromOrderForm({ ...form, amount: '0' }, 6, 100)).toMatch(/^Amount:/)
    expect(fromOrderForm({ ...form, amount: '1.1234567' }, 6, 100)).toMatch(/^Amount:/)
    expect(fromOrderForm({ ...form, trigger: '0' }, 6, 100)).toMatch(/^Price:/)
    expect(fromOrderForm({ ...form, slippage: '1.5' }, 6, 100)).toBe(
      "Slippage: write a percent up to this agent's 1.00.",
    )
  })
})
