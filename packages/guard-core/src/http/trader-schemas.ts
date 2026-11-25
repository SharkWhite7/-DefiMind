import { z } from 'zod'
import { address, webAuthnResponse } from './schemas.js'

const DAY_MINUTES = 24 * 60

/** CR-027. Strict, so a misspelt cap fails instead of being dropped and read as unset. */
export const traderConfig = z
  .strictObject({
    enabled: z.boolean(),
    mode: z.enum(['shadow', 'live']),
    model: z
      .enum(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
      .default('claude-opus-5-5'),
    effort: z.enum(['low', 'medium', 'high']).default('medium'),
    cadenceMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]),
    tokens: z.array(address).max(64),
    instructions: z.string().max(2000),
    template: z
      .strictObject({ id: z.string().min(1).max(64), version: z.number().int().positive() })
      .optional(),
    maxActionsPerTick: z.number().int().min(1).max(5).default(3),
    maxTicksPerDay: z
      .number()
      .int()
      .min(1)
      .max(DAY_MINUTES / 5)
      .optional(),
    maxTokensPerTick: z.number().int().min(1).max(1_000_000).default(200_000),
    maxTokensPerDay: z.number().int().min(1).max(100_000_000).default(2_000_000),
  })
  .transform(({ maxTicksPerDay, ...config }) => ({
    ...config,
    maxTicksPerDay: maxTicksPerDay ?? DAY_MINUTES / config.cadenceMinutes,
  }))

export const traderPut = z.object({ config: traderConfig, assertion: webAuthnResponse.optional() })
export const traderResume = z.object({ assertion: webAuthnResponse.optional() })
export const ticksQuery = z.object({ before: z.iso.datetime().optional() })
