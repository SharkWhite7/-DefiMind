import { and, desc, eq, gte, lt } from 'drizzle-orm'
import type { Db } from './client.js'
import { priceSamples } from './trader-schema.js'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export type Window = '1h' | '24h'

export function savePrice(
  db: Db,
  chain: string,
  mint: string,
  priceUsd: string,
  at: Date,
  step: 1 | 15 = 15,
): void {
  db.insert(priceSamples)
    .values({ chain, mint, at: at.toISOString(), priceUsd, step })
    .onConflictDoNothing()
    .run()
}

/**
 * Oldest first. "24h": the 15-minute series, at most 96 samples. "1h": every sample of the last
 * hour, at most 60, from the one-minute series where it runs (CR-028).
 */
export function recentPrices(
  db: Db,
  chain: string,
  mint: string,
  now: Date,
  window: Window = '24h',
) {
  const hour = window === '1h'
  const since = new Date(now.getTime() - (hour ? HOUR_MS : DAY_MS)).toISOString()
  const where = and(
    eq(priceSamples.chain, chain),
    eq(priceSamples.mint, mint),
    gte(priceSamples.at, since),
    ...(hour ? [] : [eq(priceSamples.step, 15)]),
  )
  return db
    .select({ at: priceSamples.at, priceUsd: priceSamples.priceUsd })
    .from(priceSamples)
    .where(where)
    .orderBy(desc(priceSamples.at))
    .limit(hour ? 60 : 96)
    .all()
    .reverse()
}

/** The latest sample at or before `at`, from either series. */
export function priceAt(db: Db, chain: string, mint: string, at: Date) {
  return db
    .select({ at: priceSamples.at, priceUsd: priceSamples.priceUsd })
    .from(priceSamples)
    .where(
      and(
        eq(priceSamples.chain, chain),
        eq(priceSamples.mint, mint),
        lt(priceSamples.at, new Date(at.getTime() + 1).toISOString()),
      ),
    )
    .orderBy(desc(priceSamples.at))
    .get()
}

/** The 15-minute series is kept for 7 days, the one-minute series for 24 hours. */
export function prunePrices(db: Db, now: Date): void {
  const week = new Date(now.getTime() - 7 * DAY_MS).toISOString()
  const day = new Date(now.getTime() - DAY_MS).toISOString()
  db.delete(priceSamples).where(lt(priceSamples.at, week)).run()
  db.delete(priceSamples)
    .where(and(eq(priceSamples.step, 1), lt(priceSamples.at, day)))
    .run()
}
