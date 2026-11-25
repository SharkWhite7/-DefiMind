import type { BalanceChange, RejectCode } from '@defimind/shared'

/** One token account of the hot wallet, as the chain holds it. */
export interface Holding {
  mint: string
  owner: string
  amount: bigint
  /** For wSOL these are the wrapped SOL plus the rent: a SOL leg is counted in them. */
  lamports: bigint
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
  /** What the transaction pays in fees. */
  fee: bigint
  /** The rent-exempt minimum of each account the swap opens for the hot wallet, wSOL aside. */
  rent: bigint
  /** The hot wallet's own wSOL account: the one a SOL leg may close. */
  wsolAccount: string
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
 *
 * A SOL leg (CR-026) is counted in lamports alone: the hot wallet's, and those of every wSOL account
 * it owns, rent included, so moving SOL between them nets to nothing and only SOL that leaves the
 * hot wallet counts. Only its own wSOL account may close.
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
    const wsol = !!sol && (now ?? was)?.mint === WSOL
    if (wsol) {
      if (now) ok &&= isPlain(now, deal.hotWallet)
      else ok &&= address === deal.wsolAccount
      add(WSOL, (now?.lamports ?? 0n) - (was?.lamports ?? 0n))
      continue
    }
    if (!now) {
      // Never held, or gone: a closed account of the hot wallet is an effect no swap needs.
      ok &&= was === null
      continue
    }
    if (was && was.mint !== now.mint) ok = false
    ok &&= isPlain(now, deal.hotWallet)
    const delta = now.amount - (was?.amount ?? 0n)
    if (delta < 0n && now.mint !== deal.tokenIn) ok = false
    add(now.mint, delta)
  }
  const cost = deal.fee + deal.rent
  const lamportsDelta = lamports.after - lamports.before
  if (sol) add(WSOL, lamportsDelta)
  else ok &&= -lamportsDelta <= cost
  // A SOL leg's lamports also pay the fees and rent, so those are allowed for on that side.
  const spent = -(net.get(deal.tokenIn) ?? 0n) - (sol === 'in' ? cost : 0n)
  const bought = (net.get(deal.tokenOut) ?? 0n) + (sol === 'out' ? cost : 0n)
  ok &&= spent <= deal.amountIn && bought >= deal.minAmountOut
  // Reported gross of the fee and the rent, as any other leg: the trade's own amount. Its SOL cost
  // is held above and by the gas reserve.
  if (sol) add(WSOL, cost)
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
