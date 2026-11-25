import type { TradingPolicy } from '@defimind/shared'
import { describe, expect, it } from 'vitest'
import { type Book, limitReasons } from '../src/domain/trade-limits.js'

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
const book: Book = {
  tradedToday: 0n,
  soldToday: 0n,
  swappedToday: 0n,
  positionCost: 0n,
  positionAmount: 5_000n,
  boughtBefore: true,
}
const buy = (usd: bigint) => ({ side: 'buy' as const, token: BONK, amountIn: usd, valueUsd: usd })
const sell = (amount: bigint, usd: bigint) => ({
  side: 'sell' as const,
  token: BONK,
  amountIn: amount,
  valueUsd: usd,
})
const limits = (over: Partial<TradingPolicy>) => ({ ...trading, ...over })

describe('trade limits (CR-026)', () => {
  it("keeps CR-021's limits when no operation or token limit is set", () => {
    expect(limitReasons(trading, buy(10_000_000n), book)).toEqual([])
    expect(limitReasons(trading, buy(10_000_001n), book)).toEqual(['TRADE_EXCEEDED'])
    expect(limitReasons(trading, buy(1n), { ...book, tradedToday: 25_000_000n })).toEqual([
      'TRADE_DAILY_EXCEEDED',
    ])
    expect(limitReasons(trading, buy(1n), { ...book, positionCost: 20_000_000n })).toEqual([
      'POSITION_EXCEEDED',
    ])
    expect(limitReasons(trading, sell(5_000n, 999_000_000n), book)).toEqual([])
  })

  it("puts the buy operation's limits in place of the defaults", () => {
    const own = limits({ operations: { buy: { maxTradeUsd: '30000000', dailyMax: '2000000' } } })
    expect(limitReasons(own, buy(15_000_000n), book)).toEqual(['TRADE_DAILY_EXCEEDED'])
    expect(limitReasons(own, buy(2_000_000n), book)).toEqual([])
  })

  it("lowers a token's buy and replaces its held limit", () => {
    const own = limits({
      tokenLimits: { [BONK]: { maxBuyUsd: '1000000', maxHeldUsd: '50000000' } },
    })
    expect(limitReasons(own, buy(1_000_001n), book)).toEqual(['TOKEN_LIMIT_EXCEEDED'])
    expect(limitReasons(own, buy(1_000_000n), { ...book, positionCost: 40_000_000n })).toEqual([])
    expect(limitReasons(own, buy(1_000_000n), { ...book, positionCost: 49_000_001n })).toEqual([
      'TOKEN_LIMIT_EXCEEDED',
    ])
    expect(limitReasons(own, buy(1n), { ...book, positionCost: 30_000_000n })).toEqual([])
  })

  it('never sells more than the agent holds, unless nothing is held to check against', () => {
    expect(limitReasons(trading, sell(5_001n, 1n), book)).toEqual(['INSUFFICIENT_POSITION'])
    const { positionAmount: _held, ...shadow } = book
    expect(limitReasons(trading, sell(5_001n, 1n), shadow)).toEqual([])
  })

  it("holds sells to the sell operation's limits, per trade and per day", () => {
    const own = limits({ operations: { sell: { maxTradeUsd: '1000000', dailyMax: '1500000' } } })
    expect(limitReasons(own, sell(1n, 1_000_001n), book)).toEqual(['SELL_EXCEEDED'])
    expect(limitReasons(own, sell(1n, 600_000n), { ...book, soldToday: 1_000_000n })).toEqual([
      'SELL_DAILY_EXCEEDED',
    ])
    expect(limitReasons(own, sell(1n, 500_000n), { ...book, soldToday: 1_000_000n })).toEqual([])
  })

  it('holds a swap to its own caps, or to the buy limits without them, on its own day', () => {
    const swap = (usd: bigint, amount = 1n) => ({
      side: 'swap' as const,
      token: BONK,
      amountIn: amount,
      valueUsd: usd,
    })
    expect(limitReasons(trading, swap(10_000_001n), book)).toEqual(['SWAP_EXCEEDED'])
    expect(limitReasons(trading, swap(1n), { ...book, swappedToday: 25_000_000n })).toEqual([
      'SWAP_DAILY_EXCEEDED',
    ])
    const own = limits({ operations: { swap: { maxTradeUsd: '100', dailyMax: '150' } } })
    expect(limitReasons(own, swap(101n), book)).toEqual(['SWAP_EXCEEDED'])
    expect(limitReasons(own, swap(60n), { ...book, swappedToday: 100n })).toEqual([
      'SWAP_DAILY_EXCEEDED',
    ])
    expect(limitReasons(trading, swap(1n, 5_001n), book)).toEqual(['INSUFFICIENT_POSITION'])
    const capped = limits({ tokenLimits: { [BONK]: { maxBuyUsd: '5' } } })
    expect(limitReasons(capped, swap(6n), book)).toEqual(['TOKEN_LIMIT_EXCEEDED'])
  })
})
