import type { Address, ChainId, TraderAction, TraderConfig, TraderTick } from '@defimind/shared'
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { agents } from './schema.js'

export type PausedBy = 'owner' | 'kill' | 'agent_paused' | 'errors' | 'refusals'

/**
 * CR-027: at most one AI trader per agent. `streak` counts the ticks in a row that ended the same
 * bad way, `streakKind`, so three errors pause it and an error between refusals starts over.
 */
export const traders = sqliteTable('traders', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agents.id),
  config: text('config', { mode: 'json' }).$type<TraderConfig>().notNull(),
  pausedBy: text('paused_by').$type<PausedBy>(),
  streakKind: text('streak_kind').$type<'error' | 'refused'>(),
  streak: integer('streak').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
})

export const traderTicks = sqliteTable(
  'trader_ticks',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    startedAt: text('started_at').notNull(),
    day: text('day').notNull(),
    model: text('model').notNull(),
    outcome: text('outcome').$type<TraderTick['outcome']>().notNull(),
    actions: text('actions', { mode: 'json' }).$type<TraderAction[]>().notNull(),
    reason: text('reason').notNull(),
    input: integer('input').notNull(),
    output: integer('output').notNull(),
    cacheRead: integer('cache_read').notNull(),
    cacheWrite: integer('cache_write').notNull(),
    detail: text('detail'),
    /** Saved as it runs, so a crash still leaves what it spent and did on the record. */
    running: integer('running', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('trader_ticks_agent').on(t.agentId, t.startedAt)],
)

/** What recent_prices reads: a quoteSell of 10 dollars' worth, every 15 minutes, kept 7 days. */
export const priceSamples = sqliteTable(
  'price_samples',
  {
    chain: text('chain').$type<ChainId>().notNull(),
    mint: text('mint').$type<Address>().notNull(),
    at: text('at').notNull(),
    priceUsd: text('price_usd').notNull(),
  },
  (t) => [primaryKey({ columns: [t.chain, t.mint, t.at] })],
)
