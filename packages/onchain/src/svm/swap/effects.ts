import type { BalanceChange, RejectCode } from '@defimind/shared'

/** One token account of the hot wallet, as the chain holds it. */
export interface Holding {
  mint: string
  owner: string
  amount: bigint
  delegate: string | null
  closeAuthority: string | null
  frozen: boolean
}

export interface Deal {
  hotWallet: string
  tokenIn: string
  amountIn: bigint
  tokenOut: string
  minAmountOut: bigint
  /** Fees and the rent of accounts the swap may create: all the SOL it may cost. */
  maxLamports: bigint
}

export interface Effects {
  reasons: RejectCode[]
  /** The hot wallet's net change per mint, in atomic units. */
  changes: BalanceChange[]
}

const WSOL = 'So11111111111111111111111111111111111111112'

/**
 * The test run's verdict, from the hot wallet's token accounts before and after it (SPEC v0.16, step
 * 4). tokenIn falls by at most amountIn, tokenOut rises by at least minAmountOut, no other account
 * loses anything, SOL pays fees and rent only, and every account stays the hot wallet's alone: no
 * delegate, no close authority, not frozen, not closed. Anything else is SIM_UNEXPECTED_EFFECT.
 * With a SOL leg (CR-026) the lamports and the hot wallet's wSOL count as one leg, and its wSOL
 * account may close, back into those lamports.
 */
export function swapEffects(
  before: Map<string, Holding | null>,
  after: Map<string, Holding | null>,
  lamports: { before: bigint; after: bigint },
  deal: Deal,
): Effects {
  const sol = deal.tokenIn === WSOL ? 'in' : deal.tokenOut === WSOL ? 'out' : undefined
  const net = new Map<string, bigint>()
  const add = (mint: string, delta: bigint) => net.set(mint, (net.get(mint) ?? 0n) + delta)
  let ok = true
  for (const address of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(address) ?? null
    const now = after.get(address) ?? null
    if (!now) {
      // Never held, or gone: a closed account of the hot wallet is an effect no swap needs, but
      // the unwrap of a SOL leg.
      if (sol && was?.mint === WSOL) add(WSOL, -was.amount)
      else ok &&= was === null
      continue
    }
    if (was && was.mint !== now.mint) ok = false
    ok &&= isPlain(now, deal.hotWallet)
    const delta = now.amount - (was?.amount ?? 0n)
    if (delta < 0n && now.mint !== deal.tokenIn) ok = false
    add(now.mint, delta)
  }
  const lamportsDelta = lamports.after - lamports.before
  if (sol) add(WSOL, lamportsDelta)
  else ok &&= -lamportsDelta <= deal.maxLamports
  // A SOL leg's lamports also pay the fees and rent, so they are allowed for on that side.
  const spent = -(net.get(deal.tokenIn) ?? 0n) - (sol === 'in' ? deal.maxLamports : 0n)
  const bought = (net.get(deal.tokenOut) ?? 0n) + (sol === 'out' ? deal.maxLamports : 0n)
  ok &&= spent <= deal.amountIn && bought >= deal.minAmountOut
  return {
    reasons: ok ? [] : ['SIM_UNEXPECTED_EFFECT'],
    changes: [...net]
      .filter(([, delta]) => delta !== 0n)
      .map(([token, delta]) => ({ token, delta: delta.toString() })),
  }
}

const isPlain = (holding: Holding, hotWallet: string) =>
  holding.owner === hotWallet &&
  holding.delegate === null &&
  holding.closeAuthority === null &&
  !holding.frozen
