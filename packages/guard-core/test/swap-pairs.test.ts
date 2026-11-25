import type { TradingPolicy } from '@defimind/shared'
import { describe, expect, it, vi } from 'vitest'
import { schema } from '../src/db/client.js'
import * as repo from '../src/db/repo.js'
import { applyTrade, getPosition } from '../src/db/trades.js'
import { hashToken } from '../src/domain/auth.js'
import { WSOL } from '../src/domain/valuation.js'
import { CHAIN, harness, MINT as USDC, NOW } from './harness.js'
import { BONK, trading, Venue } from './venue.js'

const WIF = 'Wif1111111111111111111111111111111111111111'

/** An agent holding 5 WIF-units at 2 dollars, and some BONK already, so the swap is not a first buy. */
async function setup(over: Partial<TradingPolicy> = {}, balance?: bigint) {
  const chain = new Venue(balance)
  const policy = { trading: { ...trading, tokens: [BONK, WIF], ...over } }
  const h = await harness({ chain, policy })
  const hold = (token: string, amount: bigint, cost: bigint) => {
    chain.held.set(token, amount)
    applyTrade(
      h.db,
      { agentId: 'agent-1', chain: CHAIN, token, side: 'buy', amount, cost, decimals: 5 },
      NOW,
    )
  }
  hold(WIF, 5_000_000n, 2_000_000n)
  hold(BONK, 1n, 1n)
  return { h, chain, hold }
}

const swap = (amountIn = '1000000', extra: object = {}) => ({
  agentId: 'agent-1',
  chain: CHAIN,
  tokenIn: WIF,
  tokenOut: BONK,
  amountIn,
  reason: 'rotate',
  ...extra,
})

describe('token-to-token swaps (CR-026)', () => {
  it('trades one held token for another, moving cost in proportion to the amount sold', async () => {
    const { h, chain } = await setup()
    const res = await h.agent('POST', '/v1/agent/swap', swap())
    expect(res.json()).toMatchObject({ status: 'executed' })
    expect(chain.topUps).toEqual([])
    // 1/5 of the WIF went, so 1/5 of its cost moved to BONK; the swap realises nothing.
    expect(getPosition(h.db, 'agent-1', CHAIN, WIF)).toEqual({
      amount: 4_000_000n,
      cost: 1_600_000n,
    })
    expect(getPosition(h.db, 'agent-1', CHAIN, BONK)).toEqual({ amount: 995_001n, cost: 400_001n })
  })

  it('quotes a swap with its valuation, the higher of the two legs', async () => {
    const { h } = await setup()
    const { reason: _reason, ...order } = swap()
    const quote = (await h.agent('POST', '/v1/agent/quote', order)).json()
    expect(quote).toMatchObject({ minAmountOut: '995000', valueUsd: '1000' })
  })

  it('never spends more than the position holds, and is never topped up', async () => {
    const { h, chain } = await setup()
    const over = await h.agent('POST', '/v1/agent/swap', swap('5000001'))
    expect(over.json()).toMatchObject({ rejectReasons: ['INSUFFICIENT_POSITION'] })
    const empty = await setup({}, 0n)
    const short = await empty.h.agent('POST', '/v1/agent/swap', swap())
    expect(short.json()).toMatchObject({ rejectReasons: ['INSUFFICIENT_POSITION'] })
    expect(empty.chain.topUps).toEqual([])
    expect(chain.sent).toEqual([])
  })

  it('refuses a swap it cannot value within the impact limit', async () => {
    const { h, chain } = await setup()
    chain.sellImpactBps = 301
    const res = await h.agent('POST', '/v1/agent/swap', swap())
    expect(res.json().rejectReasons).toContain('VALUATION_UNAVAILABLE')
  })

  it("holds a swap to the swap operation's caps", async () => {
    const operations = { swap: { maxTradeUsd: '999', dailyMax: '1500' } }
    const { h } = await setup({ operations })
    const res = await h.agent('POST', '/v1/agent/swap', swap())
    expect(res.json().rejectReasons).toEqual(['SWAP_EXCEEDED'])
    const roomy = await setup({ operations: { swap: { maxTradeUsd: '1000', dailyMax: '1500' } } })
    expect((await roomy.h.agent('POST', '/v1/agent/swap', swap())).json().status).toBe('executed')
    const again = await roomy.h.agent('POST', '/v1/agent/swap', swap())
    expect(again.json().rejectReasons).toEqual(['SWAP_DAILY_EXCEEDED'])
  })

  it('keeps the fee coin the next sell needs', async () => {
    const { h, chain } = await setup()
    vi.spyOn(chain, 'getHotWalletGas').mockResolvedValue({
      balance: '1',
      minimum: '2',
      symbol: 'SOL',
    })
    const res = await h.agent('POST', '/v1/agent/swap', swap())
    expect(res.json()).toMatchObject({ rejectReasons: ['GAS_RESERVE'] })
  })

  it('lets a sell to the dollar through on low gas: its own test run decides (SPEC v0.21)', async () => {
    const { h, chain } = await setup()
    vi.spyOn(chain, 'getHotWalletGas').mockResolvedValue({
      balance: '1',
      minimum: '2',
      symbol: 'SOL',
    })
    const res = await h.agent('POST', '/v1/agent/swap', swap('1000000', { tokenOut: USDC }))
    expect(res.json()).toMatchObject({ status: 'executed' })
  })

  it('holds a sell of SOL itself to the reserve: it spends the fee coin', async () => {
    const { h, chain, hold } = await setup({ tokens: [BONK, WIF, WSOL] })
    hold(WSOL, 50_000_000n, 7_000_000n)
    vi.spyOn(chain, 'getHotWalletGas').mockResolvedValue({
      balance: '60000000',
      minimum: '20000000',
      symbol: 'SOL',
    })
    const sell = (amountIn: string) => swap(amountIn, { tokenIn: WSOL, tokenOut: USDC })
    const all = await h.agent('POST', '/v1/agent/swap', sell('50000000'))
    expect(all.json()).toMatchObject({ rejectReasons: ['GAS_RESERVE'] })
    const some = await h.agent('POST', '/v1/agent/swap', sell('30000000'))
    expect(some.json()).toMatchObject({ status: 'executed' })
  })

  it('has two agents on the shared wallet take turns, from the test run to the signature', async () => {
    const { h, chain } = await setup()
    const token = 'second-agent-token-long-enough'
    h.db
      .insert(schema.agents)
      .values({
        id: 'agent-2',
        name: 'agent-2',
        tokenHash: hashToken(token),
        createdAt: NOW.toISOString(),
      })
      .run()
    const policy = repo.getPolicy(h.db, 'agent-1')
    if (policy !== undefined) {
      repo.putPolicy(h.db, { ...policy, agentId: 'agent-2' }, NOW.toISOString())
    }
    applyTrade(
      h.db,
      {
        agentId: 'agent-2',
        chain: CHAIN,
        token: WIF,
        side: 'buy',
        amount: 5_000_000n,
        cost: 1n,
        decimals: 5,
      },
      NOW,
    )
    const steps: string[] = []
    const simulate = chain.simulate.bind(chain)
    const send = chain.send.bind(chain)
    vi.spyOn(chain, 'simulate').mockImplementation(async (intent) => {
      steps.push(`test ${intent.agentId}`)
      await new Promise((done) => setTimeout(done, 20))
      return simulate(intent)
    })
    vi.spyOn(chain, 'send').mockImplementation(async (intent) => {
      steps.push(`sign ${intent.agentId}`)
      return send(intent)
    })
    const as = (bearer: string, agentId: string) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/agent/swap',
        headers: { authorization: `Bearer ${bearer}` },
        payload: swap('1000000', { agentId }),
      })
    await Promise.all([h.agent('POST', '/v1/agent/swap', swap()), as(token, 'agent-2')])
    expect(steps).toHaveLength(4)
    expect(steps[0]?.split(' ')[1]).toBe(steps[1]?.split(' ')[1])
    expect(steps[2]?.split(' ')[1]).toBe(steps[3]?.split(' ')[1])
  })
})
