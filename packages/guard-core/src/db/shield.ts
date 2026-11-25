import type { ChainId } from '@defimind/shared'
import { and, eq } from 'drizzle-orm'
import type { MintFacts } from '../domain/shield.js'
import type { Db } from './client.js'
import { shieldBaselines } from './schema.js'

type Key = { agentId: string; chain: ChainId; token: string }

const where = (key: Key) =>
  and(
    eq(shieldBaselines.agentId, key.agentId),
    eq(shieldBaselines.chain, key.chain),
    eq(shieldBaselines.token, key.token),
  )

export function getBaseline(db: Db, key: Key): MintFacts | undefined {
  const row = db.select().from(shieldBaselines).where(where(key)).get()
  return row === undefined
    ? undefined
    : {
        freezeAuthority: row.freezeAuthority,
        mintAuthority: row.mintAuthority,
        extensions: row.extensions,
        supply: row.supply,
      }
}

export function saveBaseline(db: Db, key: Key, facts: MintFacts, at: Date): void {
  const value = { ...facts, takenAt: at.toISOString() }
  db.insert(shieldBaselines)
    .values({ ...key, ...value })
    .onConflictDoUpdate({
      target: [shieldBaselines.agentId, shieldBaselines.chain, shieldBaselines.token],
      set: value,
    })
    .run()
}

/** Takes the baseline from the chain; a token whose mint cannot be read gets one at its first check. */
export async function takeBaseline(
  db: Db,
  adapter: { tokenRisk?: (mint: string) => Promise<MintFacts> },
  key: Key,
  at: Date,
): Promise<void> {
  const read = await adapter.tokenRisk?.(key.token).catch(() => undefined)
  if (read !== undefined) {
    const { freezeAuthority, mintAuthority, extensions, supply } = read
    saveBaseline(db, key, { freezeAuthority, mintAuthority, extensions, supply }, at)
  }
}
