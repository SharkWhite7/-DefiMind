import type { Amount, Order, OrderKind, RejectCode } from '@defimind/shared'
import { isSvm } from '@defimind/shared'
import { randomUUID } from 'node:crypto'
import { moveOrder, openOrders, saveOrder } from '../db/orders.js'
import * as repo from '../db/repo.js'
import { getPosition } from '../db/trades.js'
import { placeReasons } from '../domain/orders.js'
import type { PaymentDeps } from './payments.js'

export interface OrderInput {
  agentId: string
  chain: string
  token: string
  kind: OrderKind
  amount: Amount
  triggerOut: Amount
  maxSlippageBps?: number | undefined
  expiresAt?: string | undefined
}

/**
 * Places a take-profit or stop-loss (CR-026), or says why not. It never waits for the owner: a
 * fill only sells, under every trading check. Solana only, on a token that is not the dollar.
 */
export function placeOrder(
  deps: PaymentDeps,
  input: OrderInput,
  createdBy: 'agent' | 'owner',
): Order | RejectCode[] {
  const { db, now } = deps
  const policy = repo.getPolicy(db, input.agentId)
  const dollar = deps.usdc.get(input.chain)
  if (policy === undefined) {
    return ['PAUSED']
  }
  if (!isSvm(input.chain) || dollar === undefined || !policy.chains.includes(input.chain)) {
    return ['CHAIN_NOT_ALLOWED']
  }
  if (input.token === dollar) {
    return ['TOKEN_NOT_TRADABLE']
  }
  const maxSlippageBps = input.maxSlippageBps ?? policy.trading?.maxSlippageBps ?? 0
  const held =
    policy.mode === 'shadow'
      ? undefined
      : getPosition(db, input.agentId, input.chain, input.token).amount
  const open = openOrders(db, input.agentId)
  const reasons = placeReasons(policy, { ...input, maxSlippageBps }, open, held)
  if (reasons.length > 0) {
    return reasons
  }
  const order: Order = {
    id: randomUUID(),
    agentId: input.agentId,
    chain: input.chain,
    token: input.token,
    kind: input.kind,
    amount: input.amount,
    triggerOut: input.triggerOut,
    maxSlippageBps,
    createdBy,
    status: 'open',
    createdAt: now().toISOString(),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  }
  saveOrder(db, order)
  const { id, kind, token, amount } = order
  repo.audit(
    db,
    {
      event: 'order_placed',
      agentId: order.agentId,
      detail: { id, kind, token, amount, createdBy },
    },
    now(),
  )
  return order
}

/** Cancels one open order; cancelling only tightens, so it needs no passkey. */
export function cancelOrder(deps: PaymentDeps, order: Order, via: string): void {
  if (moveOrder(deps.db, order.id, 'cancelled')) {
    repo.audit(
      deps.db,
      { event: 'order_cancelled', agentId: order.agentId, detail: { id: order.id, via } },
      deps.now(),
    )
  }
}

/** Close positions and kill cancel every open order, or one agent's. */
export function cancelOpen(deps: PaymentDeps, via: string, agentId?: string): number {
  const open = openOrders(deps.db, agentId)
  for (const order of open) {
    cancelOrder(deps, order, via)
  }
  return open.length
}
