import type { BalanceChange } from '@defimind/shared'
import type { ConfirmedTransactionMeta, TokenBalance } from '@solana/web3.js'

const WSOL = 'So11111111111111111111111111111111111111112'

/**
 * The owner's balance changes in a confirmed transaction, per mint, from its own record, each gross
 * of the network fee and the rent of the accounts it opened, as the test run reports them. SOL
 * (CR-026) is counted in lamports, the owner's own and those of every wSOL account it holds, and
 * reported under the wSOL mint: a swap that unwraps leaves no wSOL account behind to read.
 */
export function landedChanges(
  meta: ConfirmedTransactionMeta,
  owner: string,
  ownerIndex: number,
): BalanceChange[] {
  if (meta.err) throw new Error(`tx_failed: ${JSON.stringify(meta.err)}`)
  const lamports = (i: number) =>
    BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0)
  const ours = (balances: TokenBalance[] | null | undefined) =>
    (balances ?? []).filter((b) => b.owner === owner)
  const pre = ours(meta.preTokenBalances)
  const post = ours(meta.postTokenBalances)
  const totals = new Map<string, bigint>()
  const add = (mint: string, delta: bigint) => totals.set(mint, (totals.get(mint) ?? 0n) + delta)
  for (const b of pre) if (b.mint !== WSOL) add(b.mint, -BigInt(b.uiTokenAmount.amount))
  for (const b of post) if (b.mint !== WSOL) add(b.mint, BigInt(b.uiTokenAmount.amount))

  const wsol = new Set([...pre, ...post].filter((b) => b.mint === WSOL).map((b) => b.accountIndex))
  const opened = post.filter(
    (b) => b.mint !== WSOL && !pre.some((p) => p.accountIndex === b.accountIndex),
  )
  const sol =
    lamports(ownerIndex) +
    [...wsol].reduce((sum, i) => sum + lamports(i), 0n) +
    (ownerIndex === 0 ? BigInt(meta.fee) : 0n) +
    opened.reduce((sum, b) => sum + lamports(b.accountIndex), 0n)
  add(WSOL, sol)
  return [...totals]
    .filter(([, delta]) => delta !== 0n)
    .map(([token, delta]) => ({ token, delta: delta.toString() }))
}
