import { randomUUID } from 'node:crypto'

type Body = Record<string, unknown> | undefined

/**
 * The CR-021 agent routes, shaped as the SPEC says and nothing more: a fixed price of 50 units of
 * any token per dollar, 1% slippage, and a policy that allows only `tradable` and buys under $20.
 * A quote for a token not held yet carries NEW_TOKEN. Unlike guard-core, which sends such a buy to
 * the owner, the mock only holds back buys of $10 or more, so a demo can trade without an owner.
 * A token-to-token swap (CR-026) trades one for one and moves the cost with it; orders are stored
 * and listed, never filled.
 */
export function tradingRoutes(options: { usd: string; tradable: string[]; now: () => Date }) {
  const held = new Map<string, { amount: bigint; cost: bigint }>()
  let tradedToday = 0n
  const LIMIT = 20_000_000n

  function quote(body: Body) {
    const tokenIn = String(body?.['tokenIn'])
    const tokenOut = String(body?.['tokenOut'])
    const amountIn = BigInt(String(body?.['amountIn']))
    const buy = tokenIn === options.usd
    const sell = tokenOut === options.usd
    const expectedOut = buy ? amountIn * 50n : sell ? amountIn / 50n : amountIn
    return {
      venue: 'jupiter',
      tokenIn,
      amountIn: amountIn.toString(),
      tokenOut,
      expectedOut: expectedOut.toString(),
      minAmountOut: ((expectedOut * 99n) / 100n).toString(),
      slippageBps: 100,
      priceImpactBps: 10,
      exitImpactBps: buy ? 12 : null,
      risks: [],
      flags: buy && !held.has(tokenOut) ? ['NEW_TOKEN'] : [],
      quotedAt: options.now().toISOString(),
      decimalsIn: 6,
      decimalsOut: 6,
    }
  }

  /** One for one, and the cost of what was spent moves with it. */
  function rotate(tokenIn: string, tokenOut: string, amount: bigint) {
    const from = held.get(tokenIn)
    if (from === undefined || from.amount < amount) {
      return {
        intentId: randomUUID(),
        status: 'rejected',
        rejectReasons: ['INSUFFICIENT_POSITION'],
      }
    }
    const moved = (from.cost * amount) / from.amount
    held.set(tokenIn, { amount: from.amount - amount, cost: from.cost - moved })
    const to = held.get(tokenOut) ?? { amount: 0n, cost: 0n }
    held.set(tokenOut, { amount: to.amount + amount, cost: to.cost + moved })
    return {
      intentId: randomUUID(),
      status: 'executed',
      txId: `mock-${randomUUID()}`,
      rejectReasons: [],
    }
  }

  function swap(body: Body) {
    const priced = quote(body)
    if (priced.tokenIn !== options.usd && priced.tokenOut !== options.usd) {
      return options.tradable.includes(priced.tokenOut)
        ? rotate(priced.tokenIn, priced.tokenOut, BigInt(priced.amountIn))
        : { intentId: randomUUID(), status: 'rejected', rejectReasons: ['TOKEN_NOT_TRADABLE'] }
    }
    const buy = priced.tokenIn === options.usd
    const token = buy ? priced.tokenOut : priced.tokenIn
    const amountIn = BigInt(priced.amountIn)
    const reasons = [
      ...(options.tradable.includes(token) ? [] : ['TOKEN_NOT_TRADABLE']),
      ...(buy && tradedToday + amountIn > LIMIT ? ['TRADE_DAILY_EXCEEDED'] : []),
    ]
    if (reasons.length > 0) {
      return { intentId: randomUUID(), status: 'rejected', rejectReasons: reasons }
    }
    if (buy && amountIn >= 10_000_000n) {
      return { intentId: randomUUID(), status: 'pending_approval', rejectReasons: [] }
    }
    const position = held.get(token) ?? { amount: 0n, cost: 0n }
    if (buy) {
      tradedToday += amountIn
      held.set(token, {
        amount: position.amount + BigInt(priced.expectedOut),
        cost: position.cost + amountIn,
      })
    } else {
      held.set(token, { ...position, amount: position.amount - amountIn })
    }
    return {
      intentId: randomUUID(),
      status: 'executed',
      txId: `mock-${randomUUID()}`,
      rejectReasons: [],
    }
  }

  const placed = new Map<string, Record<string, unknown>>()

  function orders(
    method: string,
    path: string,
    body: Body,
    chain: string,
  ): [number, unknown] | undefined {
    if (method === 'POST' && path === '/v1/agent/orders') {
      const token = String(body?.['token'])
      if (BigInt(String(body?.['amount'])) > (held.get(token)?.amount ?? 0n)) {
        return [422, { error: 'outside_policy', rejectReasons: ['INSUFFICIENT_POSITION'] }]
      }
      const order = {
        id: randomUUID(),
        agentId: String(body?.['agentId']),
        chain,
        token,
        kind: body?.['kind'],
        amount: String(body?.['amount']),
        triggerOut: String(body?.['triggerOut']),
        maxSlippageBps: Number(body?.['maxSlippageBps'] ?? 100),
        createdBy: 'agent',
        status: 'open',
        createdAt: options.now().toISOString(),
      }
      placed.set(order.id, order)
      return [200, order]
    }
    const cancel = /^\/v1\/agent\/orders\/([^/]+)\/cancel$/.exec(path)
    if (method === 'POST' && cancel !== null) {
      const order = placed.get(cancel[1] ?? '')
      if (order === undefined) {
        return [404, { error: 'not_found' }]
      }
      order['status'] = 'cancelled'
      return [200, order]
    }
    if (method === 'GET' && path.startsWith('/v1/agent/orders/')) {
      return [200, { orders: [...placed.values()] }]
    }
    return undefined
  }

  /** Returns undefined for a path these routes do not serve. */
  return (
    method: string,
    path: string,
    body: Body,
    chain: string,
  ): [number, unknown] | undefined => {
    if (method === 'POST' && path === '/v1/agent/quote') {
      return [200, quote(body)]
    }
    if (method === 'POST' && path === '/v1/agent/swap') {
      return [200, swap(body)]
    }
    const ordered = orders(method, path, body, chain)
    if (ordered !== undefined) {
      return ordered
    }
    if (method === 'GET' && path.startsWith('/v1/agent/portfolio/')) {
      const positions = [...held].map(([token, { amount, cost }]) => ({
        chain,
        token,
        amount: amount.toString(),
        cost: cost.toString(),
        decimals: 6,
      }))
      return [
        200,
        { positions, tradedToday: tradedToday.toString(), dailyTradeMax: LIMIT.toString() },
      ]
    }
    return undefined
  }
}
