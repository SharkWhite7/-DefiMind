import { describe, expect, it } from 'vitest'
import { swapEffects, type Deal, type Holding } from '../src/svm/swap/effects.js'

const hot = 'HotWa11et'
const usdc = 'USDC'
const bonk = 'BONK'
const deal: Deal = {
  hotWallet: hot,
  tokenIn: usdc,
  amountIn: 10_000_000n,
  tokenOut: bonk,
  minAmountOut: 500n,
  maxLamports: 3_000_000n,
}
const holding = (mint: string, amount: bigint, change: Partial<Holding> = {}): Holding => ({
  mint,
  owner: hot,
  amount,
  delegate: null,
  closeAuthority: null,
  frozen: false,
  ...change,
})
const sol = { before: 1_000_000_000n, after: 999_990_000n }

function run(
  before: Record<string, Holding | null>,
  after: Record<string, Holding | null>,
  lamports = sol,
) {
  return swapEffects(
    new Map(Object.entries(before)),
    new Map(Object.entries(after)),
    lamports,
    deal,
  )
}

describe('the test run of a swap', () => {
  it('passes a buy that spends at most amountIn and gets at least minAmountOut, in a new account', () => {
    const effects = run(
      { a: holding(usdc, 25_000_000n), b: null },
      { a: holding(usdc, 15_000_000n), b: holding(bonk, 512n) },
    )
    expect(effects).toEqual({
      reasons: [],
      changes: [
        { token: usdc, delta: '-10000000' },
        { token: bonk, delta: '512' },
      ],
    })
  })

  it.each([
    ['spends more than amountIn', { a: holding(usdc, 14_999_999n), b: holding(bonk, 512n) }],
    ['gets less than minAmountOut', { a: holding(usdc, 15_000_000n), b: holding(bonk, 499n) }],
    [
      'takes from another account of the hot wallet',
      { a: holding(usdc, 15_000_000n), b: holding(bonk, 512n), c: holding('JUP', 9n) },
    ],
    [
      'leaves a delegate on an account',
      { a: holding(usdc, 15_000_000n, { delegate: 'thief' }), b: holding(bonk, 512n) },
    ],
    [
      'hands an account to another owner',
      { a: holding(usdc, 15_000_000n), b: holding(bonk, 512n, { owner: 'thief' }) },
    ],
    [
      'sets a close authority',
      { a: holding(usdc, 15_000_000n, { closeAuthority: 'thief' }), b: holding(bonk, 512n) },
    ],
    [
      'freezes an account',
      { a: holding(usdc, 15_000_000n), b: holding(bonk, 512n, { frozen: true }) },
    ],
    ['closes an account', { a: null, b: holding(bonk, 512n), c: holding('JUP', 10n) }],
  ])('refuses a run that %s', (_case, after) => {
    const before = { a: holding(usdc, 25_000_000n), b: null, c: holding('JUP', 10n) }
    expect(run(before, after as Record<string, Holding | null>).reasons).toEqual([
      'SIM_UNEXPECTED_EFFECT',
    ])
  })

  it('refuses SOL spent past fees and rent', () => {
    const before = { a: holding(usdc, 25_000_000n), b: null }
    const after = { a: holding(usdc, 15_000_000n), b: holding(bonk, 512n) }
    expect(run(before, after, { before: 10_000_000n, after: 7_000_000n }).reasons).toEqual([])
    expect(run(before, after, { before: 10_000_000n, after: 6_999_999n }).reasons).toEqual([
      'SIM_UNEXPECTED_EFFECT',
    ])
  })

  it('refuses an account whose mint changed', () => {
    const effects = run({ a: holding(usdc, 25_000_000n) }, { a: holding(bonk, 512n) })
    expect(effects.reasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })
})

describe('a SOL leg (CR-026): lamports and wSOL as one leg', () => {
  const WSOL = 'So11111111111111111111111111111111111111112'
  const fees = 5_000n
  const judge = (
    leg: Partial<Deal>,
    before: Record<string, Holding | null>,
    after: Record<string, Holding | null>,
    lamports: { before: bigint; after: bigint },
  ) =>
    swapEffects(new Map(Object.entries(before)), new Map(Object.entries(after)), lamports, {
      ...deal,
      ...leg,
    })

  it('passes selling SOL: amountIn and fees leave the lamports, the wSOL account comes and goes', () => {
    const effects = judge(
      { tokenIn: WSOL, amountIn: 10_000_000n },
      { w: null, b: holding(bonk, 0n) },
      { w: null, b: holding(bonk, 600n) },
      { before: 1_000_000_000n, after: 1_000_000_000n - 10_000_000n - fees },
    )
    expect(effects.reasons).toEqual([])
    expect(effects.changes).toEqual([
      { token: bonk, delta: '600' },
      { token: WSOL, delta: `-${10_000_000n + fees}` },
    ])
  })

  it('refuses selling more SOL than amountIn and the fees and rent allow', () => {
    const effects = judge(
      { tokenIn: WSOL, amountIn: 10_000_000n },
      { b: holding(bonk, 0n) },
      { b: holding(bonk, 600n) },
      { before: 1_000_000_000n, after: 1_000_000_000n - 10_000_000n - 3_000_001n },
    )
    expect(effects.reasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })

  it('passes buying SOL into the lamports, the unwrapped wSOL account closing back', () => {
    const effects = judge(
      { tokenIn: usdc, tokenOut: WSOL, minAmountOut: 50_000_000n },
      { a: holding(usdc, 25_000_000n), w: holding(WSOL, 2_000n) },
      { a: holding(usdc, 15_000_000n), w: null },
      { before: 1_000_000_000n, after: 1_000_000_000n + 50_000_000n - fees },
    )
    expect(effects.reasons).toEqual([])
    expect(effects.changes).toContainEqual({ token: WSOL, delta: `${50_000_000n - fees - 2_000n}` })
  })

  it('still refuses a closed account that is not the wSOL one', () => {
    const effects = judge(
      { tokenIn: WSOL, amountIn: 10_000_000n },
      { b: holding(bonk, 7n) },
      { b: null },
      { before: 1_000_000_000n, after: 1_000_000_000n - 10_000_000n - fees },
    )
    expect(effects.reasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })
})
