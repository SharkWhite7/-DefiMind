import type { SimulationOutcome } from '@defimind/onchain'
import type { PayIntent, SwapQuote, TradingPolicy } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { StubChain } from '../src/adapters/stub.js'
import { getPosition } from '../src/db/trades.js'
import { CHAIN, harness, MINT as USDC, NOW } from './harness.js'
import { signedIn } from './owner.js'

const BONK = 'Bonk111111111111111111111111111111111111111'
const trading: TradingPolicy = {
  enabled: true,
  venues: ['jupiter'],
  tokens: [BONK],
  allowAnyToken: false,
  maxTradeUsd: '10000000',
  dailyTradeMax: '25000000',
  maxPositionUsd: '20000000',
  maxSlippageBps: 100,
  maxPriceImpactBps: 300,
}

/** A chain whose venue quotes 1 USDC = 1000 BONK, and whose test run gives what was quoted. */
class Venue extends StubChain {
  quotes = 0
  down: 'venue_unavailable' | 'no_route' | undefined
  received: bigint | undefined
  held = new Map<string, bigint>()

  constructor(balance = 100_000_000n) {
    super(CHAIN, balance)
  }

  async quoteSwap(req: { tokenIn: string; tokenOut: string; amountIn: string }) {
    this.quotes += 1
    if (this.down !== undefined) {
      throw Object.assign(new Error(this.down), { code: this.down })
    }
    const buy = req.tokenIn === USDC
    const out = buy ? BigInt(req.amountIn) * 1000n : BigInt(req.amountIn) / 1000n
    const quote: SwapQuote = {
      venue: 'jupiter',
      ...req,
      expectedOut: `${out}`,
      minAmountOut: `${(out * 995n) / 1000n}`,
      slippageBps: 50,
      priceImpactBps: 10,
      exitImpactBps: 12,
      risks: [],
      flags: [],
      quotedAt: NOW.toISOString(),
      decimalsIn: buy ? 6 : 5,
      decimalsOut: buy ? 5 : 6,
    }
    return quote
  }

  async getPositions() {
    return [...this.held].map(([token, amount]) => ({ token, amount: `${amount}`, decimals: 5 }))
  }

  override async simulate(intent: PayIntent): Promise<SimulationOutcome> {
    if (intent.swap === undefined) {
      return super.simulate(intent)
    }
    const got = this.received ?? BigInt(intent.swap.minAmountOut)
    return {
      simulation: {
        summary: `swaps ${intent.amount} of ${intent.token}`,
        balanceChanges: [
          { token: intent.token, delta: `-${intent.amount}` },
          { token: intent.swap.tokenOut, delta: `${got}` },
        ],
      },
      rejectReasons: [],
    }
  }
}

async function setup(
  options: {
    trading?: Partial<TradingPolicy> | null
    mode?: 'live' | 'shadow'
    balance?: bigint
  } = {},
) {
  const chain = new Venue(options.balance)
  const policy = {
    ...(options.trading === null ? {} : { trading: { ...trading, ...options.trading } }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  }
  const h = await harness({ chain, policy })
  // The first buy of a token goes to the owner; most cases here are about the rest.
  return { h, chain }
}

const buy = (amountIn = '1000000', extra: object = {}) => ({
  agentId: 'agent-1',
  chain: CHAIN,
  tokenIn: USDC,
  tokenOut: BONK,
  amountIn,
  reason: 'buy the dip',
  ...extra,
})

const sell = (amountIn: string) => ({ ...buy(amountIn), tokenIn: BONK, tokenOut: USDC })

async function bought(h: Awaited<ReturnType<typeof setup>>['h']) {
  const res = await h.agent('POST', '/v1/agent/swap', buy())
  const owner = await signedIn(h)
  await owner.call('POST', `/v1/owner/intents/${res.json().intentId}/decision`, {
    decision: 'approve',
    assertion: await owner.stepUp('approve_intent', { intentId: res.json().intentId }),
  })
  return owner
}

describe('swaps (CR-021)', () => {
  it('sends the first buy of a token to the owner, then executes it once approved', async () => {
    const { h, chain } = await setup()
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'pending_approval', rejectReasons: [] })
    expect(chain.sent).toHaveLength(0)
    await bought(h)
    expect(chain.sent).toHaveLength(1)
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK)).toEqual({
      amount: 995_000_000n,
      cost: 1_000_000n,
    })
  })

  it('executes a later buy of a known token without asking, and counts it as traded', async () => {
    const { h, chain } = await setup()
    await bought(h)
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'executed', txId: 'stub-tx-2' })
    expect(chain.sent[1]).toMatchObject({ kind: 'swap', token: USDC, swap: { tokenOut: BONK } })
    const portfolio = (await h.agent('GET', '/v1/agent/portfolio/agent-1')).json()
    expect(portfolio.tradedToday).toBe('2000000')
  })

  it('counts buys against dailyTradeMax and never against dailyMax', async () => {
    const { h } = await setup({ trading: { dailyTradeMax: '1500000' } })
    await bought(h)
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({
      status: 'rejected',
      rejectReasons: ['TRADE_DAILY_EXCEEDED'],
    })
    const budget = (await h.agent('GET', '/v1/agent/budget/agent-1')).json()
    expect(JSON.stringify(budget)).not.toContain('1000000"')
  })

  it('sells without asking, reducing the position at cost', async () => {
    const { h } = await setup()
    await bought(h)
    const res = await h.agent('POST', '/v1/agent/swap', sell('497500000'))
    expect(res.json()).toMatchObject({ status: 'executed' })
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK)).toEqual({
      amount: 497_500_000n,
      cost: 500_000n,
    })
  })

  it('tops the hot wallet up for a buy before the test run', async () => {
    const { h, chain } = await setup({ balance: 0n })
    await bought(h)
    expect(chain.topUps).toEqual(['1000000'])
  })

  it('refuses without trading, before asking the venue', async () => {
    const { h, chain } = await setup({ trading: null })
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'rejected', rejectReasons: ['TRADING_DISABLED'] })
    expect(chain.quotes).toBe(0)
  })

  it('refuses a pair without the chain dollar on one side', async () => {
    const { h } = await setup()
    const res = await h.agent('POST', '/v1/agent/swap', { ...buy(), tokenIn: 'Wif1111111111111' })
    expect(res.json()).toMatchObject({ rejectReasons: ['TOKEN_NOT_TRADABLE'] })
  })

  it('refuses when the venue has no route, and answers 502 when it is down', async () => {
    const { h, chain } = await setup()
    chain.down = 'no_route'
    expect((await h.agent('POST', '/v1/agent/swap', buy())).json()).toMatchObject({
      rejectReasons: ['NO_EXIT_ROUTE'],
    })
    chain.down = 'venue_unavailable'
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.statusCode).toBe(502)
    expect(res.json()).toEqual({ error: 'venue_unavailable' })
  })

  it('refuses a test run that brings in less than the minimum', async () => {
    const { h, chain } = await setup()
    await bought(h)
    chain.received = 1n
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ rejectReasons: ['SIM_UNEXPECTED_EFFECT'] })
  })

  it('paper trades in shadow: live quote, test run, nothing drawn or signed', async () => {
    const { h, chain } = await setup({ mode: 'shadow', balance: 0n })
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'shadowed' })
    expect(chain.quotes).toBe(1)
    expect(chain.topUps).toEqual([])
    expect(chain.sent).toEqual([])
  })

  it('never signs in shadow, even with the dollar in the hot wallet and a clean test run', async () => {
    const { h, chain } = await setup({ mode: 'shadow' })
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'shadowed' })
    expect(h.auditEvents(res.json().intentId)).toContain('simulated')
    expect(chain.sent).toEqual([])
    expect(chain.topUps).toEqual([])
  })

  it('refuses a swap when the policy allows payments only inside a mandate', async () => {
    const chain = new Venue()
    const h = await harness({ chain, policy: { trading, requireMandate: true } })
    const res = await h.agent('POST', '/v1/agent/swap', buy())
    expect(res.json()).toMatchObject({ status: 'rejected', rejectReasons: ['MANDATE_REQUIRED'] })
    expect(chain.sent).toEqual([])
  })

  it('answers a quote read-only, and refuses it without trading', async () => {
    const { h } = await setup()
    const quote = await h.agent('POST', '/v1/agent/quote', buy())
    expect(quote.json()).toMatchObject({ venue: 'jupiter', minAmountOut: '995000000' })
    const off = await setup({ trading: null })
    expect((await off.h.agent('POST', '/v1/agent/quote', buy())).statusCode).toBe(403)
  })
})

describe('the owner Close (CR-021)', () => {
  it('needs the passkey, then sells every token, even with the agent paused', async () => {
    const { h, chain } = await setup()
    const owner = await bought(h)
    chain.held.set(BONK, 995_000_000n)
    await owner.call('POST', '/v1/owner/pause', { agentId: 'agent-1' })
    const none = await owner.call('POST', '/v1/owner/positions/close', {})
    expect(none.json()).toEqual({ error: 'step_up_required' })
    const res = await owner.call('POST', '/v1/owner/positions/close', {
      assertion: await owner.stepUp('close_positions', {}),
    })
    expect(res.json().intents).toEqual([
      expect.objectContaining({ kind: 'swap', token: BONK, status: 'executed' }),
    ])
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK)).toEqual({ amount: 0n, cost: 0n })
  })
})
