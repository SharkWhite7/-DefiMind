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
  fee: 1_000_000n,
  rent: 2_000_000n,
  wsolAccount: 'own-wsol',
}
const holding = (mint: string, amount: bigint, change: Partial<Holding> = {}): Holding => ({
  mint,
  owner: hot,
  amount,
  lamports: 2_039_280n,
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

describe('a SOL leg (CR-026), counted in lamports alone', () => {
  const WSOL = 'So11111111111111111111111111111111111111112'
  const rent = 2_039_280n
  const fees = 5_000n
  const wsol = (lamports: bigint) => holding(WSOL, lamports - rent, { lamports })
  const judge = (
    leg: Partial<Deal>,
    before: Record<string, Holding | null>,
    after: Record<string, Holding | null>,
    lamports: { before: bigint; after: bigint },
  ) =>
    swapEffects(new Map(Object.entries(before)), new Map(Object.entries(after)), lamports, {
      ...deal,
      fee: fees,
      rent: 0n,
      ...leg,
    })
  const hot = 1_000_000_000n

  it('passes selling SOL: amountIn and the fee leave, the wSOL account comes and goes', () => {
    const effects = judge(
      { tokenIn: WSOL, amountIn: 10_000_000n },
      { 'own-wsol': null, b: holding(bonk, 0n) },
      { 'own-wsol': null, b: holding(bonk, 600n) },
      { before: hot, after: hot - 10_000_000n - fees },
    )
    expect(effects.reasons).toEqual([])
    expect(effects.changes).toEqual([
      { token: bonk, delta: '600' },
      // Gross of the fee: the trade's own amount, as any leg is reported.
      { token: WSOL, delta: '-10000000' },
    ])
  })

  it('refuses selling more SOL than amountIn and the fee', () => {
    const effects = judge(
      { tokenIn: WSOL, amountIn: 10_000_000n },
      { b: holding(bonk, 0n) },
      { b: holding(bonk, 600n) },
      { before: hot, after: hot - 10_000_000n - fees - 1n },
    )
    expect(effects.reasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })

  it('passes buying SOL into the lamports, its own wSOL account closing back', () => {
    const effects = judge(
      { tokenIn: usdc, tokenOut: WSOL, minAmountOut: 50_000_000n },
      { a: holding(usdc, 25_000_000n), 'own-wsol': wsol(rent + 2_000n) },
      { a: holding(usdc, 15_000_000n), 'own-wsol': null },
      { before: hot, after: hot + 50_000_000n + rent + 2_000n - fees },
    )
    expect(effects.reasons).toEqual([])
    expect(effects.changes).toContainEqual({ token: WSOL, delta: '50000000' })
  })

  // The integrator's attack on #167: the proceeds parked in a stray wSOL account while the same
  // lamports leave the hot wallet. Counted in lamports, the hot wallet got nothing.
  it('refuses proceeds parked in a stray wSOL account while as much SOL leaves', () => {
    const A = 50_000_000n
    const effects = judge(
      { tokenIn: bonk, amountIn: 600n, tokenOut: WSOL, minAmountOut: A },
      { b: holding(bonk, 600n), stray: null },
      { b: holding(bonk, 0n), stray: wsol(rent + A) },
      { before: hot, after: hot - A - rent - fees },
    )
    expect(effects.reasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })

  it('refuses closing a wSOL account other than its own', () => {
    const effects = judge(
      { tokenIn: usdc, tokenOut: WSOL, minAmountOut: 1n },
      { a: holding(usdc, 25_000_000n), stray: wsol(rent + 9n) },
      { a: holding(usdc, 15_000_000n), stray: null },
      { before: hot, after: hot + rent + 9n + 5_000_000n },
    )
    expect(effects.reasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })

  it('credits no proceeds for closing its own wSOL account that held SOL before', () => {
    const effects = judge(
      { tokenIn: usdc, tokenOut: WSOL, minAmountOut: 50_000_000n },
      { a: holding(usdc, 25_000_000n), 'own-wsol': wsol(rent + 50_000_000n) },
      { a: holding(usdc, 15_000_000n), 'own-wsol': null },
      { before: hot, after: hot + rent + 50_000_000n - fees },
    )
    expect(effects.reasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })

  it('still refuses a closed account that is not wSOL', () => {
    const effects = judge(
      { tokenIn: WSOL, amountIn: 10_000_000n },
      { b: holding(bonk, 7n) },
      { b: null },
      { before: hot, after: hot - 10_000_000n - fees },
    )
    expect(effects.reasons).toEqual(['SIM_UNEXPECTED_EFFECT'])
  })
})
