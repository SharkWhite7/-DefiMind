import type { Amount, ChainId, Position } from '@defimind/shared'
import { and, eq, sql } from 'drizzle-orm'
import { parseAmount, toAmount } from '../domain/amount.js'
import type { Db } from './client.js'
import { dailyTrades, positions } from './schema.js'

export function boughtToday(db: Db, agentId: string, chain: ChainId, day: string): bigint {
  const row = db
    .select({ bought: dailyTrades.bought })
    .from(dailyTrades)
    .where(
      and(eq(dailyTrades.agentId, agentId), eq(dailyTrades.chain, chain), eq(dailyTrades.day, day)),
    )
    .get()
  return row === undefined ? 0n : parseAmount(row.bought)
}

/** Read and written in one transaction, so two buys at once cannot both read the old total. */
export function addBought(db: Db, agentId: string, chain: ChainId, day: string, amount: Amount) {
  db.transaction((tx) => {
    const row = tx
      .select({ bought: dailyTrades.bought })
      .from(dailyTrades)
      .where(
        and(
          eq(dailyTrades.agentId, agentId),
          eq(dailyTrades.chain, chain),
          eq(dailyTrades.day, day),
        ),
      )
      .get()
    const bought = toAmount(parseAmount(row?.bought ?? '0') + parseAmount(amount))
    tx.insert(dailyTrades)
      .values({ agentId, chain, day, bought })
      .onConflictDoUpdate({
        target: [dailyTrades.agentId, dailyTrades.chain, dailyTrades.day],
        set: { bought },
      })
      .run()
  })
}

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
    }
    const values = {
      ...trade,
      amount: toAmount(amount),
      cost: toAmount(cost),
      updatedAt: now.toISOString(),
    }
    tx.insert(positions)
      .values(values)
      .onConflictDoUpdate({
        target: [positions.agentId, positions.chain, positions.token],
        set: { amount: values.amount, cost: values.cost, updatedAt: values.updatedAt },
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
    .map(({ agentId: id, chain, token, amount, cost }) => ({
      agentId: id,
      chain,
      token,
      amount,
      cost,
    }))
}
