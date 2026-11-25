import type { Order, OrderStatus, RejectCode } from '@defimind/shared'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import type { Db } from './client.js'
import { orders } from './schema.js'

type Row = typeof orders.$inferSelect

function order(row: Row): Order {
  const { expiresAt, filledIntentId, failReason, ...rest } = row
  return {
    ...rest,
    ...(expiresAt === null ? {} : { expiresAt }),
    ...(filledIntentId === null ? {} : { filledIntentId }),
    ...(failReason === null ? {} : { failReason }),
  }
}

export function saveOrder(db: Db, value: Order): void {
  db.insert(orders)
    .values({
      ...value,
      expiresAt: value.expiresAt ?? null,
      filledIntentId: value.filledIntentId ?? null,
      failReason: value.failReason ?? null,
    })
    .run()
}

export function getOrder(db: Db, id: string): Order | undefined {
  const row = db.select().from(orders).where(eq(orders.id, id)).get()
  return row === undefined ? undefined : order(row)
}

/** Every open order, or one agent's. */
export function openOrders(db: Db, agentId?: string): Order[] {
  const open = eq(orders.status, 'open')
  return db
    .select()
    .from(orders)
    .where(agentId === undefined ? open : and(open, eq(orders.agentId, agentId)))
    .orderBy(orders.createdAt)
    .all()
    .map(order)
}

/** The open orders and the last 50 others, newest first; one agent's, or every agent's. */
export function listOrders(db: Db, agentId?: string): Order[] {
  const closed = ne(orders.status, 'open')
  const recent = db
    .select()
    .from(orders)
    .where(agentId === undefined ? closed : and(closed, eq(orders.agentId, agentId)))
    .orderBy(desc(orders.createdAt))
    .limit(50)
    .all()
    .map(order)
  return [...openOrders(db, agentId).reverse(), ...recent]
}

/**
 * Moves an order on from `from` (open, or triggered while its sell runs). One that has already
 * moved stays as it is, so a cancel and a fill cannot both win: the caller reads which did.
 */
export function moveOrder(
  db: Db,
  id: string,
  to: OrderStatus,
  extra: { filledIntentId?: string; failReason?: RejectCode } = {},
  from: OrderStatus = 'open',
): boolean {
  return (
    db
      .update(orders)
      .set({ status: to, ...extra })
      .where(and(eq(orders.id, id), eq(orders.status, from)))
      .run().changes > 0
  )
}

/** Orders whose sell was under way when guard-core stopped: none can still be running. */
export function triggeredOrders(db: Db): Order[] {
  return db.select().from(orders).where(eq(orders.status, 'triggered')).all().map(order)
}

/** What an agent's orders already promise to sell: the open ones and any being filled. */
export function liveOrders(db: Db, agentId: string): Order[] {
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.agentId, agentId), inArray(orders.status, ['open', 'triggered'])))
    .all()
    .map(order)
}
