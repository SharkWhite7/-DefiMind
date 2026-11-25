import { and, asc, eq, gte, lt } from 'drizzle-orm'
import type { Db } from './client.js'
import { priceSamples } from './trader-schema.js'

const DAY_MS = 86_400_000

export function savePrice(db: Db, chain: string, mint: string, priceUsd: string, at: Date): void {
  db.insert(priceSamples)
    .values({ chain, mint, at: at.toISOString(), priceUsd })
    .onConflictDoNothing()
    .run()
}

/** The last 24 hours, oldest first: at most 96 samples at one every 15 minutes. */
export function recentPrices(db: Db, chain: string, mint: string, now: Date) {
  const since = new Date(now.getTime() - DAY_MS).toISOString()
  return db
    .select({ at: priceSamples.at, priceUsd: priceSamples.priceUsd })
    .from(priceSamples)
    .where(
      and(eq(priceSamples.chain, chain), eq(priceSamples.mint, mint), gte(priceSamples.at, since)),
    )
    .orderBy(asc(priceSamples.at))
    .limit(96)
    .all()
}

/** Samples are kept for 7 days. */
export function prunePrices(db: Db, now: Date): void {
  const cutoff = new Date(now.getTime() - 7 * DAY_MS).toISOString()
  db.delete(priceSamples).where(lt(priceSamples.at, cutoff)).run()
}
