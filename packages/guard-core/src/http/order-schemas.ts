import { z } from 'zod'
import { address, agentId, atomicAmount, caip2, webAuthnResponse } from './schemas.js'

const positive = atomicAmount.refine((value) => value !== '0', 'must be more than zero')

/** CR-026. A take-profit or stop-loss; triggerOut is the chain's dollar for the whole amount. */
export const orderRequest = z.object({
  agentId,
  chain: caip2,
  token: address,
  kind: z.enum(['take_profit', 'stop_loss']),
  amount: positive,
  triggerOut: positive,
  maxSlippageBps: z.number().int().min(0).max(10_000).optional(),
  expiresAt: z.iso.datetime().optional(),
})
export const orderCancel = z.object({ agentId })
export const ownerOrder = orderRequest.extend({ assertion: webAuthnResponse.optional() })
