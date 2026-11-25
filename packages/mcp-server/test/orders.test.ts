import { describe, expect, it, vi } from 'vitest'
import { GuardError } from '../src/adapters/guard.js'
import type { OrderInput, PlacedOrder } from '../src/adapters/trading.js'
import { NOT_AVAILABLE } from '../src/tools/trading.js'
import { call, connect, fakeGuard } from './support.js'

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
const ORDER_ID = '0b9e4a1c-2d3e-4f50-8a6b-7c8d9e0f1a2b'

const order: PlacedOrder = {
  id: ORDER_ID,
  agentId: 'agent-1',
  chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  token: BONK,
  kind: 'stop_loss',
  amount: '250000000',
  triggerOut: '4000000',
  maxSlippageBps: 100,
  createdBy: 'agent',
  status: 'open',
  createdAt: '2026-11-25T10:00:00.000Z',
}

describe('place_order', () => {
  it('converts triggerUsd to atomic dollars and describes the order it got back', async () => {
    const placeOrder = vi.fn(async (_input: OrderInput) => order)
    const client = await connect(fakeGuard({ placeOrder }))
    const { text, isError } = await call(client, 'place_order', {
      token: BONK,
      kind: 'stop_loss',
      amount: '250000000',
      triggerUsd: '4',
    })
    expect(isError).toBe(false)
    expect(placeOrder).toHaveBeenCalledWith({
      chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      token: BONK,
      kind: 'stop_loss',
      amount: '250000000',
      triggerOut: '4000000',
    })
    expect(text).toContain(`Stop-loss ${ORDER_ID}: open.`)
    expect(text).toContain(
      `Sells 250000000 smallest units of ${BONK} when the whole amount would fetch at or below $4.00 USDC, with slippage up to 100 bps.`,
    )
    expect(text).toContain('DefiMind is watching it. cancel_order removes it.')
  })

  it('passes maxSlippageBps only when given, and refuses a bad trigger before guard-core', async () => {
    const placeOrder = vi.fn(async (_input: OrderInput) => ({
      ...order,
      kind: 'take_profit' as const,
    }))
    const client = await connect(fakeGuard({ placeOrder }))
    await call(client, 'place_order', {
      token: BONK,
      kind: 'take_profit',
      amount: '1',
      triggerUsd: '9.5',
      maxSlippageBps: 50,
    })
    expect(placeOrder.mock.calls[0]?.[0]).toMatchObject({
      triggerOut: '9500000',
      maxSlippageBps: 50,
    })
    for (const triggerUsd of ['0', '-1', '1e3']) {
      const bad = await call(client, 'place_order', {
        token: BONK,
        kind: 'take_profit',
        amount: '1',
        triggerUsd,
      })
      expect(bad.isError).toBe(true)
      expect(bad.text).toMatch(/^triggerUsd:/)
    }
    expect(placeOrder).toHaveBeenCalledTimes(1)
  })

  it('explains a refused order with its codes and what to do', async () => {
    const placeOrder = vi.fn(async (): Promise<never> => {
      throw new GuardError('http', 'AgentGuard returned an error (HTTP 422).', 422, [
        'ORDERS_DISABLED',
        'ORDER_LIMIT_EXCEEDED',
      ])
    })
    const { text, isError } = await call(await connect(fakeGuard({ placeOrder })), 'place_order', {
      token: BONK,
      kind: 'stop_loss',
      amount: '1',
      triggerUsd: '1',
    })
    expect(isError).toBe(false)
    expect(text).toContain('DefiMind refused this order (trigger $1.00); nothing was placed.')
    expect(text).toContain(
      '- ORDERS_DISABLED: the owner has not turned on take-profit and stop-loss orders',
    )
    expect(text).toContain('Tell the user the owner has to turn orders on.')
    expect(text).toContain(
      "Only an order this agent placed can be cancelled with cancel_order; the owner's orders are the owner's to cancel.",
    )
  })

  it('says a stop-loss is not a guarantee, and to place orders only when asked', async () => {
    const { tools } = await (await connect(fakeGuard({}))).listTools()
    const description = tools.find((tool) => tool.name === 'place_order')?.description ?? ''
    expect(description).toContain('A stop is not a guarantee')
    expect(description).toContain('Place one only when the user asks for it.')
    expect(description).not.toMatch(/(?<!take[-_])profit|guaranteed|earn|yield/i)
  })
})

describe('trailing stops (CR-028)', () => {
  it('places one with its trail and no trigger, and refuses a trail on any other kind', async () => {
    const placeOrder = vi.fn(async () => ({
      ...order,
      kind: 'trailing_stop' as const,
      triggerOut: '0',
      trailBps: 1000,
    }))
    const client = await connect(fakeGuard({ placeOrder }))
    const { text } = await call(client, 'place_order', {
      token: order.token,
      kind: 'trailing_stop',
      amount: '1000',
      trailBps: 1000,
    })
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'trailing_stop', triggerOut: '0', trailBps: 1000 }),
    )
    expect(text).toContain('Trails its high by 1000 bps; confirmed high not set yet.')
    expect(text).toContain('once it has a confirmed high to trail; no level yet')
    const wrong = await call(client, 'place_order', {
      token: order.token,
      kind: 'stop_loss',
      amount: '1000',
      triggerUsd: '1',
      trailBps: 1000,
    })
    expect(wrong.text).toContain('trailBps: give it for a trailing_stop, and only for one.')
  })
})

describe('cancel_order and list_orders', () => {
  it('cancels by id', async () => {
    const cancelOrder = vi.fn(async () => ({ ...order, status: 'cancelled' as const }))
    const { text } = await call(await connect(fakeGuard({ cancelOrder })), 'cancel_order', {
      orderId: ORDER_ID,
    })
    expect(cancelOrder).toHaveBeenCalledWith(ORDER_ID)
    expect(text).toContain(`Stop-loss ${ORDER_ID}: cancelled.`)
    expect(text).toContain('Cancelled; nothing was sold.')
  })

  it('reads a 404 on cancel as an order this agent does not have', async () => {
    const cancelOrder = vi.fn(async (): Promise<never> => {
      throw new GuardError('http', 'AgentGuard has no record of that.', 404)
    })
    const { text } = await call(await connect(fakeGuard({ cancelOrder })), 'cancel_order', {
      orderId: ORDER_ID,
    })
    expect(text).toBe(`This agent has no order ${ORDER_ID}. list_orders shows its orders.`)
  })

  it('lists open orders first, then filled and failed ones with their outcome', async () => {
    const orders = vi.fn(async () => [
      {
        ...order,
        id: '1b9e4a1c-2d3e-4f50-8a6b-7c8d9e0f1a2b',
        status: 'failed' as const,
        failReason: 'SLIPPAGE_TOO_HIGH',
      },
      order,
      {
        ...order,
        id: '2b9e4a1c-2d3e-4f50-8a6b-7c8d9e0f1a2b',
        kind: 'take_profit' as const,
        status: 'filled' as const,
        filledIntentId: '3b9e4a1c-2d3e-4f50-8a6b-7c8d9e0f1a2b',
        createdBy: 'owner' as const,
      },
    ])
    const { text } = await call(await connect(fakeGuard({ orders })), 'list_orders')
    expect(text.indexOf(`${ORDER_ID}: open`)).toBeLessThan(text.indexOf(': failed'))
    expect(text).toContain('Not sold; the tokens are still held.')
    expect(text).toContain('Reason: SLIPPAGE_TOO_HIGH: the slippage asked for is above the limit')
    expect(text).toContain('Placed by the owner')
    expect(text).toContain(
      'The sale is intent 3b9e4a1c-2d3e-4f50-8a6b-7c8d9e0f1a2b; check_intent shows it.',
    )
  })

  it('says when there are none', async () => {
    const { text } = await call(await connect(fakeGuard({ orders: async () => [] })), 'list_orders')
    expect(text).toBe('No orders.')
  })

  it('says orders are not available on a guard-core without them', async () => {
    const missing = async (): Promise<never> => {
      throw new GuardError('http', 'AgentGuard has no record of that.', 404)
    }
    const client = await connect(fakeGuard({ placeOrder: missing, orders: missing }))
    expect((await call(client, 'list_orders')).text).toBe(NOT_AVAILABLE)
    const placed = await call(client, 'place_order', {
      token: BONK,
      kind: 'stop_loss',
      amount: '1',
      triggerUsd: '1',
    })
    expect(placed.text).toBe(NOT_AVAILABLE)
  })
})

describe("guard-core's 409 order_refused (GC-72)", () => {
  it('reaches the agent as a refusal with per-code advice, not as an error', async () => {
    const fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'order_refused',
          rejectReasons: ['INSUFFICIENT_POSITION', 'ORDERS_DISABLED'],
        }),
        { status: 409 },
      )
    const { httpGuard } = await import('../src/adapters/guard.js')
    const guard = httpGuard({ baseUrl: 'http://guard:8787', agentId: 'agent-1', token: 't', fetch })
    const { text, isError } = await call(await connect(guard), 'place_order', {
      token: BONK,
      kind: 'take_profit',
      amount: '1',
      triggerUsd: '3',
    })
    expect(isError).toBe(false)
    expect(text).toContain('DefiMind refused this order (trigger $3.00); nothing was placed.')
    expect(text).toContain(
      '- INSUFFICIENT_POSITION: the agent holds less of this token than the trade or order needs',
    )
    expect(text).toContain('open orders on the token count against it too')
    expect(text).toContain('Tell the user the owner has to turn orders on.')
  })
})

describe('advice added with the AI trader codes', () => {
  it('tells the user the spending wallet needs SOL for fees on GAS_RESERVE', async () => {
    const { explainStatus } = await import('../src/domain/explain.js')
    expect(explainStatus('rejected', ['GAS_RESERVE'], 'swap')).toContain(
      'Tell the user: the spending wallet needs a little SOL for network fees.',
    )
  })

  it("never suggests cancelling the owner's orders", async () => {
    const { adviceFor } = await import('../src/domain/explain.js')
    const advice = adviceFor(['ORDER_LIMIT_EXCEEDED']).join(' ')
    expect(advice).not.toMatch(/cancel an order the user/i)
    expect(advice).toContain("the owner's orders are the owner's to cancel")
  })
})
