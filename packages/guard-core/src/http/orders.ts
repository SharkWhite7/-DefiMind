import type { Order, RejectCode } from '@defimind/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { getOrder, listOrders } from '../db/orders.js'
import * as repo from '../db/repo.js'
import { cancelOrder, type OrderInput, placeOrder } from '../service/orders.js'
import type { PaymentDeps } from '../service/payments.js'
import type { OwnerAction } from '../service/step-up.js'
import { HttpError } from './errors.js'
import { orderCancel, orderRequest, ownerCancel, ownerOrder } from './order-schemas.js'
import { agentIdParam, idParam } from './schemas.js'

/** A refused order answers 409 with the reasons, as a refused swap's intent carries them. */
function placed(reply: FastifyReply, result: Order | RejectCode[]) {
  return Array.isArray(result)
    ? reply.code(409).send({ error: 'order_refused', rejectReasons: result })
    : result
}

/** The order, if it is this agent's: another agent's order is reported as missing. */
function own(deps: PaymentDeps, id: string, agentId?: string): Order {
  const order = getOrder(deps.db, id)
  if (order === undefined || (agentId !== undefined && order.agentId !== agentId)) {
    throw new HttpError(404, 'not_found')
  }
  return order
}

/**
 * CR-026, behind the agent's token. An agent places its own orders and cancels only those it placed;
 * it lists the owner's too, each marked with createdBy.
 */
export function agentOrderRoutes(deps: PaymentDeps) {
  return async (app: FastifyInstance) => {
    app.post('/orders', async (request, reply) => {
      const body = orderRequest.parse(request.body)
      if (body.agentId !== request.agentId) {
        throw new HttpError(403, 'forbidden')
      }
      return placed(reply, placeOrder(deps, body, 'agent'))
    })
    app.post('/orders/:id/cancel', async (request) => {
      const { id } = idParam.parse(request.params)
      const { agentId } = orderCancel.parse(request.body)
      if (agentId !== request.agentId) {
        throw new HttpError(403, 'forbidden')
      }
      const order = own(deps, id, agentId)
      // The owner's orders are listed to the agent but are not its to cancel: a hijacked agent
      // must not remove the stop-loss the owner set with the passkey.
      if (order.createdBy === 'owner') {
        throw new HttpError(404, 'not_found')
      }
      cancelOrder(deps, order, 'agent')
      return own(deps, id)
    })
    app.get('/orders/:agentId', async (request) => {
      const { agentId } = agentIdParam.parse(request.params)
      if (agentId !== request.agentId) {
        throw new HttpError(403, 'forbidden')
      }
      return { orders: listOrders(deps.db, agentId) }
    })
  }
}

/**
 * CR-026, behind the owner's session. Placing needs the step-up over the order as sent. Cancelling
 * a take-profit only tightens, so the session alone does; a stop is protection, and removing it
 * needs the step-up (CR-028), so a stolen session cannot strip a position bare.
 */
export function ownerOrderRoutes(
  deps: PaymentDeps,
  stepUp: (action: OwnerAction, body: unknown, assertion: unknown) => Promise<string>,
) {
  return async (app: FastifyInstance) => {
    app.post('/v1/owner/orders', async (request, reply) => {
      const { assertion, ...input } = ownerOrder.parse(request.body)
      if (!repo.agentExists(deps.db, input.agentId)) {
        throw new HttpError(404, 'not_found')
      }
      await stepUp('place_order', bound(input), assertion)
      return placed(reply, placeOrder(deps, input, 'owner'))
    })
    app.post('/v1/owner/orders/:id/cancel', async (request) => {
      const { id } = idParam.parse(request.params)
      const { assertion } = ownerCancel.parse(request.body ?? {})
      const order = own(deps, id)
      if (order.kind !== 'take_profit') {
        await stepUp('cancel_order', { orderId: id }, assertion)
      }
      cancelOrder(deps, order, 'panel')
      return own(deps, id)
    })
    app.get('/v1/owner/orders', async () => ({ orders: listOrders(deps.db) }))
  }
}

/**
 * SPEC's step-up body for place_order. maxSlippageBps and expiresAt only when sent, so a captured
 * assertion cannot be replayed with another expiry.
 */
function bound(input: OrderInput) {
  const { agentId, chain, token, kind, amount, triggerOut, maxSlippageBps, expiresAt, trailBps } =
    input
  return {
    agentId,
    chain,
    token,
    kind,
    amount,
    triggerOut,
    ...(maxSlippageBps === undefined ? {} : { maxSlippageBps }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(trailBps === undefined ? {} : { trailBps }),
  }
}
