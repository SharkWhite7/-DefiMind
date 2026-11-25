import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { describe, expect, it } from 'vitest'
import { openDb, schema } from '../src/db/client.js'
import { applySwap } from '../src/db/swap-book.js'
import { applyTrade, getPosition } from '../src/db/trades.js'
import { CHAIN, NOW } from './harness.js'

function book() {
  const db = openDb(':memory:')
  migrate(db, { migrationsFolder: 'migrations' })
  db.insert(schema.agents)
    .values({ id: 'agent-1', name: 'agent-1', tokenHash: 'x'.repeat(64), createdAt: '' })
    .run()
  const trade = { agentId: 'agent-1', chain: CHAIN, side: 'buy' as const, decimals: 5 }
  applyTrade(db, { ...trade, token: 'A', amount: 3n, cost: 10n }, NOW)
  const swap = (sold: bigint) =>
    applySwap(
      db,
      {
        agentId: 'agent-1',
        chain: CHAIN,
        from: { token: 'A', amount: sold },
        to: { token: 'B', amount: 7n, decimals: 6 },
      },
      NOW,
    )
  return { db, swap, position: (token: string) => getPosition(db, 'agent-1', CHAIN, token) }
}

describe('cost basis across a swap (CR-026)', () => {
  it('moves cost in proportion to the amount sold, rounded down, and keeps the remainder', () => {
    const { swap, position } = book()
    swap(1n)
    expect(position('A')).toEqual({ amount: 2n, cost: 7n })
    expect(position('B')).toEqual({ amount: 7n, cost: 3n })
  })

  it('moves the whole cost when the position is sold out, and never more than it holds', () => {
    const { swap, position } = book()
    swap(5n)
    expect(position('A')).toEqual({ amount: 0n, cost: 0n })
    expect(position('B')).toEqual({ amount: 7n, cost: 10n })
  })

  it('books what came in at no cost when nothing was held to move', () => {
    const { db, position } = book()
    applySwap(
      db,
      {
        agentId: 'agent-1',
        chain: CHAIN,
        from: { token: 'C', amount: 4n },
        to: { token: 'B', amount: 2n, decimals: 6 },
      },
      NOW,
    )
    expect(position('B')).toEqual({ amount: 2n, cost: 0n })
  })
})
