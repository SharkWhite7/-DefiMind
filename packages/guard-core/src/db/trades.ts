import type { ChainId, Position } from '@defimind/shared'
import { and, eq, sql } from 'drizzle-orm'
import { parseAmount, toAmount } from '../domain/amount.js'
import type { Db } from './client.js'
import { positions } from './schema.js'

export function getPosition(db: Db, agentId: string, chain: ChainId, token: string) {
  const row = db
    .select()
    .from(positions)
    .where(
      and(eq(positions.agentId, agentId), eq(positions.chain, chain), eq(positions.token, token)),
    )
    .get()
  return { amount: parseAmount(row?.amount ?? '0'), cost: parseAmount(row?.cost ?? '0') }
}

/** Whether any agent has ever held `token` on `chain`: the first buy of a token goes to the owner. */
export function everHeld(db: Db, chain: ChainId, token: string): boolean {
  return (
    db
      .select({ token: positions.token })
      .from(positions)
      .where(and(eq(positions.chain, chain), eq(positions.token, token)))
      .get() !== undefined
  )
}

/**
 * A buy adds what it received at what it cost. A sell takes the cost down in proportion to the
 * amount sold, so what is left keeps its average price. A position sold out keeps its row at zero:
 * it is the record that the token was bought before.
 */
export function applyTrade(
  db: Db,
  trade: {
    agentId: string
    chain: ChainId
    token: string
    side: 'buy' | 'sell'
    amount: bigint
    cost: bigint
    decimals: number
    symbol?: string
  },
  now: Date,
) {
  db.transaction((tx) => {
    const where = and(
      eq(positions.agentId, trade.agentId),
      eq(positions.chain, trade.chain),
      eq(positions.token, trade.token),
    )
    const row = tx.select().from(positions).where(where).get()
    const held = parseAmount(row?.amount ?? '0')
    const paid = parseAmount(row?.cost ?? '0')
    let amount: bigint
    let cost: bigint
    if (trade.side === 'buy') {
      amount = held + trade.amount
      cost = paid + trade.cost
    } else {
      const sold = trade.amount < held ? trade.amount : held
      amount = held - sold
      cost = held === 0n ? 0n : paid - (paid * sold) / held
      // What is left at no cost is dust from rounding or a fill that differed (GC-66): closed.
      if (cost === 0n) {
        amount = 0n
      }
    }
    const values = {
      ...trade,
      symbol: trade.symbol ?? null,
      amount: toAmount(amount),
      cost: toAmount(cost),
      updatedAt: now.toISOString(),
    }
    tx.insert(positions)
      .values(values)
      .onConflictDoUpdate({
        target: [positions.agentId, positions.chain, positions.token],
        set: {
          amount: values.amount,
          cost: values.cost,
          decimals: values.decimals,
          symbol: values.symbol ?? null,
          updatedAt: values.updatedAt,
        },
      })
      .run()
  })
}

/** An agent's open positions, or every agent's when `agentId` is left out. */
export function listPositions(db: Db, agentId?: string): (Position & { agentId: string })[] {
  return db
    .select()
    .from(positions)
    .where(
      agentId === undefined
        ? sql`${positions.amount} != '0'`
        : and(eq(positions.agentId, agentId), sql`${positions.amount} != '0'`),
    )
    .all()
    .map(({ agentId: id, chain, token, amount, cost, decimals, symbol }) => ({
      agentId: id,
      chain,
      token,
      amount,
      cost,
      decimals,
      ...(symbol === null ? {} : { symbol }),
    }))
}

/**
 * Brings the agents' positions in a token down to what the hot wallet really holds, after a swap
 * landed (GC-66): a fill below the test run's, or a balance gone to zero, must not leave a position
 * the wallet cannot back. Only the agents that wallet serves (`agents`) count; `first` loses the
 * excess first, being the agent whose trade just landed.
 * Never raised: more onchain than booked may be someone else's airdrop.
 */
export function capPositions(
  db: Db,
  where: { chain: ChainId; token: string; first: string; agents: (id: string) => boolean },
  held: bigint,
  now: Date,
) {
  const rows = listPositions(db).filter(
    (p) => p.chain === where.chain && p.token === where.token && where.agents(p.agentId),
  )
  rows.sort((a, b) => (a.agentId === where.first ? -1 : b.agentId === where.first ? 1 : 0))
  let excess = rows.reduce((sum, p) => sum + parseAmount(p.amount), 0n) - held
  for (const row of rows) {
    if (excess <= 0n) {
      return
    }
    const amount = parseAmount(row.amount)
    const cut = held === 0n || excess >= amount ? amount : excess
    excess -= cut
    db.update(positions)
      .set({
        amount: toAmount(amount - cut),
        // A position cut to nothing is closed; one cut in part keeps what it paid.
        cost: amount === cut ? '0' : row.cost,
        updatedAt: now.toISOString(),
      })
      .where(
        and(
          eq(positions.agentId, row.agentId),
          eq(positions.chain, row.chain),
          eq(positions.token, row.token),
        ),
      )
      .run()
  }
}
