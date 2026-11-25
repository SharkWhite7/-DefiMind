import type { ChainId } from '@defimind/shared'
import { and, eq } from 'drizzle-orm'
import { parseAmount, toAmount } from '../domain/amount.js'
import type { Db } from './client.js'
import { positions } from './schema.js'

/**
 * A token-to-token swap (CR-026) moves cost from the sold position to the bought one, in
 * proportion to the amount sold and rounded down; the remainder stays on the sold position until
 * it closes. A swap realises no profit or loss. One transaction, so a crash leaves both or neither.
 */
export function applySwap(
  db: Db,
  swap: {
    agentId: string
    chain: ChainId
    from: { token: string; amount: bigint }
    to: { token: string; amount: bigint; decimals: number; symbol?: string }
  },
  now: Date,
) {
  const { agentId, chain, from, to } = swap
  const where = (token: string) =>
    and(eq(positions.agentId, agentId), eq(positions.chain, chain), eq(positions.token, token))
  const updatedAt = now.toISOString()
  db.transaction((tx) => {
    const sold = tx.select().from(positions).where(where(from.token)).get()
    const held = parseAmount(sold?.amount ?? '0')
    const paid = parseAmount(sold?.cost ?? '0')
    const amount = from.amount < held ? from.amount : held
    const moved = held === 0n ? 0n : (paid * amount) / held
    if (sold !== undefined) {
      const left = held - amount
      tx.update(positions)
        .set({
          amount: toAmount(left),
          cost: toAmount(left === 0n ? 0n : paid - moved),
          updatedAt,
        })
        .where(where(from.token))
        .run()
    }
    const bought = tx.select().from(positions).where(where(to.token)).get()
    const values = {
      amount: toAmount(parseAmount(bought?.amount ?? '0') + to.amount),
      cost: toAmount(parseAmount(bought?.cost ?? '0') + moved),
      decimals: to.decimals,
      symbol: to.symbol ?? bought?.symbol ?? null,
      updatedAt,
    }
    tx.insert(positions)
      .values({ agentId, chain, token: to.token, ...values })
      .onConflictDoUpdate({
        target: [positions.agentId, positions.chain, positions.token],
        set: values,
      })
      .run()
  })
}
