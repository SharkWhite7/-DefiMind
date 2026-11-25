import { type SimulationOutcome, SwapUnavailable } from '@defimind/onchain'
import type { PayIntent, SwapQuote, TradingPolicy } from '@defimind/shared'
import { StubChain } from '../src/adapters/stub.js'
import { CHAIN, MINT as USDC, NOW } from './harness.js'

export const BONK = 'Bonk111111111111111111111111111111111111111'
export const trading: TradingPolicy = {
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
export class Venue extends StubChain {
  quotes = 0
  down: 'venue_unavailable' | 'no_route' | undefined
  received: bigint | undefined
  held = new Map<string, bigint>()
  /** Stamps quotes at the test's clock instead of NOW, for tests that run past a quote's age. */
  clock: (() => Date) | undefined

  constructor(balance = 100_000_000n) {
    super(CHAIN, balance)
  }

  /** A sell to the dollar quotes at sellOut and keeps the slippage it was asked for, as Jupiter does. */
  realistic = false

  async quoteSwap(req: {
    tokenIn: string
    tokenOut: string
    amountIn: string
    slippageBps?: number
  }) {
    this.quotes += 1
    if (this.down !== undefined) {
      throw new SwapUnavailable(this.down, 'test venue')
    }
    const buy = req.tokenIn === USDC
    // One token for one token on a swap (CR-026); 1 USDC = 1000 of any token otherwise.
    const swap = !buy && req.tokenOut !== USDC
    const market = this.realistic && !buy && !swap && this.sellOut !== undefined
    const out = buy
      ? BigInt(req.amountIn) * 1000n
      : swap
        ? BigInt(req.amountIn)
        : market
          ? BigInt(this.sellOut ?? '0')
          : BigInt(req.amountIn) / 1000n
    const slippageBps = this.realistic ? (req.slippageBps ?? 50) : 50
    const quote: SwapQuote = {
      venue: 'jupiter',
      ...req,
      expectedOut: `${out}`,
      minAmountOut: `${(out * BigInt(10_000 - slippageBps)) / 10_000n}`,
      slippageBps,
      priceImpactBps: 10,
      exitImpactBps: 12,
      risks: [],
      flags: [],
      quotedAt: NOW.toISOString(),
      decimalsIn: buy ? 6 : 5,
      decimalsOut: buy ? 5 : 6,
      ...(this.clock === undefined ? {} : { quotedAt: this.clock().toISOString() }),
    }
    return quote
  }

  /** CR-026: any token sells at 1000 for 1 USDC, unless a test moves the price. */
  sellImpactBps = 10
  /** Set to move the market the order watcher sees. */
  sellOut: string | undefined
  async quoteSell(_token: string, amount: string) {
    const out = this.sellOut ?? `${BigInt(amount) / 1000n}`
    return { out, priceImpactBps: this.sellImpactBps, quotedAt: NOW.toISOString() }
  }

  /** CR-028: what a mint read says, for the rug shield; a test changes it to make a rug. */
  mint = {
    freezeAuthority: false,
    mintAuthority: false,
    extensions: [] as string[],
    supply: '1000000',
  }
  async tokenRisk(mint: string) {
    return {
      chain: CHAIN,
      mint,
      decimals: 5,
      ...this.mint,
      risks: [],
      exit: { amountUsd: '10000000', priceImpactBps: this.sellImpactBps },
    }
  }

  /** What the swap really brings in, when the market moved after its test run. */
  landed: bigint | undefined

  override async send(intent: PayIntent): Promise<string> {
    const tx = await super.send(intent)
    const swap = intent.swap
    if (swap !== undefined) {
      const got = this.landed ?? this.received ?? BigInt(swap.minAmountOut)
      const move = (token: string, delta: bigint) => {
        const left = (this.held.get(token) ?? 0n) + delta
        this.held.set(token, left > 0n ? left : 0n)
      }
      if (intent.token !== USDC) {
        move(intent.token, -BigInt(intent.amount))
      }
      if (swap.tokenOut !== USDC) {
        move(swap.tokenOut, got)
      }
    }
    return tx
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
