import type { Amount, ChainId } from '@defimind/shared'
import { and, eq, like } from 'drizzle-orm'
import { parseAmount, toAmount } from '../domain/amount.js'
import type { Book } from '../domain/trade-limits.js'
import { expectedOf } from '../domain/trading.js'
import type { Db } from './client.js'
import { dailyTrades, intents } from './schema.js'
import { everHeld, getPosition } from './trades.js'

/** In shadow nothing is bought, so the day's limit holds against the buys that would have been. */
export function shadowBoughtToday(
  db: Db,
  agentId: string,
  chain: ChainId,
  day: string,
  dollar: string,
): bigint {
  return db
    .select({ amount: intents.amount })
    .from(intents)
    .where(
      and(
        eq(intents.agentId, agentId),
        eq(intents.chain, chain),
        eq(intents.kind, 'swap'),
        eq(intents.status, 'shadowed'),
        eq(intents.token, dollar),
        like(intents.createdAt, `${day}%`),
      ),
    )
    .all()
    .reduce((sum, row) => sum + parseAmount(row.amount), 0n)
}

/** Every chain's buys today, for the portfolio. */
export function boughtTodayAll(db: Db, agentId: string, day: string): bigint {
  return db
    .select({ bought: dailyTrades.bought })
    .from(dailyTrades)
    .where(and(eq(dailyTrades.agentId, agentId), eq(dailyTrades.day, day)))
    .all()
    .reduce((sum, row) => sum + parseAmount(row.bought), 0n)
}

type Counter = 'bought' | 'sold' | 'swapped' | 'quick'

function today(db: Db, agentId: string, chain: ChainId, day: string, counter: Counter): bigint {
  const row = db
    .select({
      bought: dailyTrades.bought,
      sold: dailyTrades.sold,
      swapped: dailyTrades.swapped,
      quick: dailyTrades.quick,
    })
    .from(dailyTrades)
    .where(
      and(eq(dailyTrades.agentId, agentId), eq(dailyTrades.chain, chain), eq(dailyTrades.day, day)),
    )
    .get()
  return row === undefined ? 0n : parseAmount(row[counter])
}

export const boughtToday = (db: Db, agentId: string, chain: ChainId, day: string) =>
  today(db, agentId, chain, day, 'bought')

/** Read and written in one transaction, so two trades at once cannot both read the old total. */
function addToday(
  db: Db,
  key: { agentId: string; chain: ChainId; day: string },
  counter: Counter,
  amount: Amount,
) {
  db.transaction((tx) => {
    const row = tx
      .select({
        bought: dailyTrades.bought,
        sold: dailyTrades.sold,
        swapped: dailyTrades.swapped,
        quick: dailyTrades.quick,
      })
      .from(dailyTrades)
      .where(
        and(
          eq(dailyTrades.agentId, key.agentId),
          eq(dailyTrades.chain, key.chain),
          eq(dailyTrades.day, key.day),
        ),
      )
      .get()
    const total = toAmount(parseAmount(row?.[counter] ?? '0') + parseAmount(amount))
    tx.insert(dailyTrades)
      .values({ ...key, [counter]: total })
      .onConflictDoUpdate({
        target: [dailyTrades.agentId, dailyTrades.chain, dailyTrades.day],
        set: { [counter]: total },
      })
      .run()
  })
}

export const addBought = (db: Db, agentId: string, chain: ChainId, day: string, amount: Amount) =>
  addToday(db, { agentId, chain, day }, 'bought', amount)

/** CR-026: a sell counts at the dollars it is expected to bring, until settlement corrects it. */
export const addSold = (db: Db, agentId: string, chain: ChainId, day: string, amount: Amount) =>
  addToday(db, { agentId, chain, day }, 'sold', amount)

/** CR-026: a token-to-token swap counts at its valuation. */
export const addSwapped = (db: Db, agentId: string, chain: ChainId, day: string, amount: Amount) =>
  addToday(db, { agentId, chain, day }, 'swapped', amount)

/** CR-028: a first buy decided without the owner, at what it spent. */
export const addQuick = (db: Db, agentId: string, chain: ChainId, day: string, amount: Amount) =>
  addToday(db, { agentId, chain, day }, 'quick', amount)

/** A sell that landed replaces what it was expected to bring with what it brought. */
export function correctSold(
  db: Db,
  key: { agentId: string; chain: ChainId; day: string },
  counted: bigint,
  read: bigint,
) {
  // A bad read can cancel this sell's own count, never eat into the other sells of the day.
  const landed = read < 0n ? 0n : read
  if (landed > counted) {
    addToday(db, key, 'sold', toAmount(landed - counted))
    return
  }
  const where = and(
    eq(dailyTrades.agentId, key.agentId),
    eq(dailyTrades.chain, key.chain),
    eq(dailyTrades.day, key.day),
  )
  db.transaction((tx) => {
    const sold = parseAmount(
      tx.select({ sold: dailyTrades.sold }).from(dailyTrades).where(where).get()?.sold ?? '0',
    )
    const less = sold - (counted - landed)
    tx.update(dailyTrades)
      .set({ sold: toAmount(less > 0n ? less : 0n) })
      .where(where)
      .run()
  })
}

/** In shadow nothing is sold either: the day's sells are the ones that would have been. */
function shadowSoldToday(db: Db, agentId: string, chain: ChainId, day: string, dollar: string) {
  return db
    .select({ swap: intents.swap })
    .from(intents)
    .where(
      and(
        eq(intents.agentId, agentId),
        eq(intents.chain, chain),
        eq(intents.kind, 'swap'),
        eq(intents.status, 'shadowed'),
        like(intents.createdAt, `${day}%`),
      ),
    )
    .all()
    .filter((row) => row.swap?.tokenOut === dollar)
    .reduce((sum, row) => sum + expectedOf(row.swap ?? undefined), 0n)
}

/**
 * What the agent's trading so far means for a trade of `token` (CR-021, CR-026). In shadow, the
 * day's totals are the paper trades', and no position is held to sell from.
 */
export function bookOf(
  db: Db,
  where: {
    agentId: string
    chain: ChainId
    token: string
    spends: string
    dollar: string
    day: string
  },
  shadow: boolean,
): Book {
  const { agentId, chain, token, dollar, day } = where
  const position = getPosition(db, agentId, chain, token)
  const spent = getPosition(db, agentId, chain, where.spends)
  return {
    tradedToday: shadow
      ? shadowBoughtToday(db, agentId, chain, day, dollar)
      : boughtToday(db, agentId, chain, day),
    soldToday: shadow
      ? shadowSoldToday(db, agentId, chain, day, dollar)
      : today(db, agentId, chain, day, 'sold'),
    // In shadow the swaps are not counted: paper swaps leave no row to sum. Their limits still hold.
    swappedToday: shadow ? 0n : today(db, agentId, chain, day, 'swapped'),
    // Shadow decides nothing for real, so its quick first buys use none of the day's room.
    quickToday: shadow ? 0n : today(db, agentId, chain, day, 'quick'),
    positionCost: position.cost,
    ...(shadow ? {} : { positionAmount: spent.amount }),
    boughtBefore: everHeld(db, chain, token),
  }
}
