import type { TraderConfig, TraderTick } from '@defimind/shared'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import type { Streak } from '../domain/trader.js'
import type { Db } from './client.js'
import { type PausedBy, traders, traderTicks } from './trader-schema.js'

export interface TraderRow {
  agentId: string
  config: TraderConfig
  pausedBy: PausedBy | null
  streak: Streak
}

export function getTrader(db: Db, agentId: string): TraderRow | undefined {
  const row = db.select().from(traders).where(eq(traders.agentId, agentId)).get()
  if (row === undefined) {
    return undefined
  }
  const { streakKind, streak, updatedAt: _, ...rest } = row
  return { ...rest, streak: { kind: streakKind, count: streak } }
}

/** The traders that are on, paused or not; the scheduler skips the paused ones. */
export function enabledTraders(db: Db): TraderRow[] {
  return db
    .select({ agentId: traders.agentId })
    .from(traders)
    .where(sql`json_extract(${traders.config}, '$.enabled') = 1`)
    .all()
    .flatMap(({ agentId }) => getTrader(db, agentId) ?? [])
}

/** A new config clears the error and refusal streaks: the owner has looked at it. */
export function saveTrader(db: Db, agentId: string, config: TraderConfig, now: Date): void {
  const values = { config, streakKind: null, streak: 0, updatedAt: now.toISOString() }
  db.insert(traders)
    .values({ agentId, pausedBy: null, ...values })
    .onConflictDoUpdate({ target: traders.agentId, set: values })
    .run()
}

export function setPaused(db: Db, agentId: string, by: PausedBy | null, now: Date): void {
  const resumed = by === null ? { streakKind: null, streak: 0 } : {}
  db.update(traders)
    .set({ pausedBy: by, ...resumed, updatedAt: now.toISOString() })
    .where(eq(traders.agentId, agentId))
    .run()
}

/** Kill pauses every trader that is not already paused, so a later resume says why it stopped. */
export function pauseAll(db: Db, by: PausedBy, now: Date): void {
  db.update(traders)
    .set({ pausedBy: by, updatedAt: now.toISOString() })
    .where(sql`${traders.pausedBy} is null`)
    .run()
}

export function setStreak(db: Db, agentId: string, streak: Streak): void {
  db.update(traders)
    .set({ streakKind: streak.kind, streak: streak.count })
    .where(eq(traders.agentId, agentId))
    .run()
}

/** Close positions turns every trader off: nothing may buy back what was just sold. */
export function disableAll(db: Db, now: Date): void {
  db.update(traders)
    .set({
      config: sql`json_set(${traders.config}, '$.enabled', json('false'))`,
      updatedAt: now.toISOString(),
    })
    .run()
}

export function saveTick(db: Db, tick: TraderTick, day: string): void {
  const { usage, detail, ...rest } = tick
  db.insert(traderTicks)
    .values({ ...rest, ...usage, day, detail: detail ?? null })
    .run()
}

type TickRow = typeof traderTicks.$inferSelect

function tick(row: TickRow): TraderTick {
  const { day: _, input, output, cacheRead, cacheWrite, detail, ...rest } = row
  return {
    ...rest,
    usage: { input, output, cacheRead, cacheWrite },
    ...(detail === null ? {} : { detail }),
  }
}

/** 50 at a time, newest first, older than `before` when given. */
export function listTicks(db: Db, agentId: string, before?: string): TraderTick[] {
  const own = eq(traderTicks.agentId, agentId)
  return db
    .select()
    .from(traderTicks)
    .where(before === undefined ? own : and(own, lt(traderTicks.startedAt, before)))
    .orderBy(desc(traderTicks.startedAt))
    .limit(50)
    .all()
    .map(tick)
}

/** The day's ticks and tokens; a skipped tick spends neither. */
export function traderToday(db: Db, agentId: string, day: string) {
  const row = db
    .select({
      ticks: sql<number>`count(*)`,
      tokens: sql<number>`coalesce(sum(${traderTicks.input} + ${traderTicks.output} + ${traderTicks.cacheRead} + ${traderTicks.cacheWrite}), 0)`,
    })
    .from(traderTicks)
    .where(
      and(
        eq(traderTicks.agentId, agentId),
        eq(traderTicks.day, day),
        sql`${traderTicks.outcome} != 'skipped'`,
      ),
    )
    .get()
  return { ticks: row?.ticks ?? 0, tokens: row?.tokens ?? 0 }
}

/** Every intent the trader ever made, for its report. */
export function traderIntents(db: Db, agentId: string): string[] {
  return db
    .select({ actions: traderTicks.actions })
    .from(traderTicks)
    .where(and(eq(traderTicks.agentId, agentId), sql`${traderTicks.actions} != '[]'`))
    .all()
    .flatMap(({ actions }) => actions.flatMap((a) => a.intentId ?? []))
}
