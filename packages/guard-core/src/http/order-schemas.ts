import { z } from 'zod'
import { address, agentId, atomicAmount, caip2, webAuthnResponse } from './schemas.js'

const positive = atomicAmount.refine((value) => value !== '0', 'must be more than zero')

/**
 * CR-026. A take-profit or stop-loss; triggerOut is the chain's dollar for the whole amount. A
 * trailing stop (CR-028) takes trailBps, and its triggerOut is a floor that may be "0".
 */
export const orderRequest = z
  .object({
    agentId,
    chain: caip2,
    token: address,
    kind: z.enum(['take_profit', 'stop_loss', 'trailing_stop']),
    amount: positive,
    triggerOut: atomicAmount,
    maxSlippageBps: z.number().int().min(0).max(10_000).optional(),
    expiresAt: z.iso.datetime().optional(),
    trailBps: z.number().int().min(100).max(5000).optional(),
  })
  .refine((o) => (o.kind === 'trailing_stop') === (o.trailBps !== undefined), {
    message: 'trailBps goes with a trailing_stop, and only with one',
    path: ['trailBps'],
  })
  .refine((o) => o.kind === 'trailing_stop' || o.triggerOut !== '0', {
    message: 'must be more than zero',
    path: ['triggerOut'],
  })
export const orderCancel = z.object({ agentId })
export const ownerOrder = z.intersection(
  orderRequest,
  z.object({ assertion: webAuthnResponse.optional() }),
)
export const ownerCancel = z.object({ assertion: webAuthnResponse.optional() })
