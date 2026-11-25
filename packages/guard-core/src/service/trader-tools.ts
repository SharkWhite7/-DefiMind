import type { RejectCode, TraderAction, TraderConfig } from '@defimind/shared'
import { z } from 'zod'
import type { TokenSearch } from '../adapters/jupiter-tokens.js'
import { getOrder } from '../db/orders.js'
import { recentPrices } from '../db/prices.js'
import * as repo from '../db/repo.js'
import { parseDollars, toAmount } from '../domain/amount.js'
import { clip } from '../domain/trader.js'
import { WSOL } from '../domain/valuation.js'
import { HttpError } from '../http/errors.js'
import { atomicAmount } from '../http/schemas.js'
import { cancelOrder, placeOrder } from './orders.js'
import type { PaymentDeps } from './payments.js'
import { portfolio } from './portfolio.js'
import { quote, swap } from './swap.js'
import { VenueUnavailable } from './swap-quote.js'
import { tokenRisk } from './token-risk.js'
import { ACTIONS } from './trader-tool-defs.js'

export interface TickContext {
  deps: PaymentDeps
  search: TokenSearch
  agentId: string
  chain: string
  config: TraderConfig
  shadow: boolean
  /** PAUSED once the trader or its agent is stopped; read again inside the wallet's lock. */
  guard: () => RejectCode | undefined
}

export interface ToolOutcome {
  content: unknown
  action?: TraderAction
  hold?: string
}

const mint = z.string().min(1).max(64)
const pair = z.strictObject({ from: mint, to: mint, amount: atomicAmount })
const slippage = z.number().int().min(0).max(10_000).optional()

const inputs = {
  get_portfolio: z.strictObject({}),
  quote: pair,
  token_risk: z.strictObject({ mint }),
  recent_prices: z.strictObject({ mint }),
  swap: pair.extend({ maxSlippageBps: slippage, reason: z.string() }),
  place_order: z
    .strictObject({
      token: mint,
      kind: z.enum(['take_profit', 'stop_loss', 'trailing_stop']),
      amount: atomicAmount,
      triggerUsd: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/),
      maxSlippageBps: slippage,
      trailBps: z.number().int().min(100).max(5000).optional(),
    })
    // CR-028: a trail only on a trailing stop, whose trigger is a floor that may be zero.
    .refine((o) => (o.kind === 'trailing_stop') === (o.trailBps !== undefined))
    .refine((o) => o.kind === 'trailing_stop' || parseDollars(o.triggerUsd) > 0n),
  cancel_order: z.strictObject({ orderId: z.string().min(1).max(64) }),
  hold: z.strictObject({ reason: z.string() }),
}

type Name = keyof typeof inputs

/** "USDC" names the chain's dollar, as the MCP tools take it, and "SOL" the wrapped SOL mint. */
function resolve(ctx: TickContext, token: string): string {
  if (token === 'SOL') {
    return WSOL
  }
  return token === 'USDC' ? (ctx.deps.usdc.get(ctx.chain) ?? token) : token
}

/** A shadow trader on a live agent: its orders would act on real funds, so it has none. */
function shadowOnLive(ctx: TickContext): boolean {
  return ctx.shadow && repo.getPolicy(ctx.deps.db, ctx.agentId)?.mode !== 'shadow'
}

function allowed(ctx: TickContext, token: string): boolean {
  return (
    token === ctx.deps.usdc.get(ctx.chain) || token === WSOL || ctx.config.tokens.includes(token)
  )
}

const refused = (tool: string): ToolOutcome => ({
  content: { refused: ['TRADER_TOKEN_NOT_ALLOWED'] },
  action: { tool, rejectReasons: ['TRADER_TOKEN_NOT_ALLOWED'] },
})

/**
 * Runs one tool call. A bad input, a refusal or a venue that is down goes back to the model as
 * data; only a bug escapes, and it ends the tick as an error.
 */
export async function runTool(ctx: TickContext, name: string, raw: unknown): Promise<ToolOutcome> {
  const schema = inputs[name as Name]
  const parsed = schema?.safeParse(raw)
  if (parsed === undefined || !parsed.success) {
    return { content: { error: 'invalid_input' } }
  }
  try {
    return await run(ctx, name as Name, parsed.data)
  } catch (error) {
    if (error instanceof VenueUnavailable || error instanceof HttpError) {
      const content = { error: error.message }
      return ACTIONS.has(name)
        ? { content, action: { tool: name, rejectReasons: [] } }
        : { content }
    }
    throw error
  }
}

async function run(ctx: TickContext, name: Name, input: unknown): Promise<ToolOutcome> {
  const { deps, agentId, chain } = ctx
  const now = deps.now()
  switch (name) {
    case 'get_portfolio':
      return { content: portfolio(deps.db, agentId, now) }
    case 'quote': {
      const { from, to, amount } = inputs.quote.parse(input)
      const policy = repo.getPolicy(deps.db, agentId)
      if (policy === undefined) {
        return { content: { error: 'not_found' } }
      }
      const req = { agentId, chain, tokenIn: resolve(ctx, from), tokenOut: resolve(ctx, to) }
      return { content: await quote(deps, { ...req, amountIn: amount }, policy) }
    }
    case 'token_risk':
      return {
        content: await tokenRisk(deps, ctx.search, chain, inputs.token_risk.parse(input).mint),
      }
    case 'recent_prices': {
      const { mint: token } = inputs.recent_prices.parse(input)
      return { content: { samples: recentPrices(deps.db, chain, token, now) } }
    }
    case 'swap':
      return trade(ctx, inputs.swap.parse(input))
    case 'place_order':
      return order(ctx, inputs.place_order.parse(input))
    case 'cancel_order': {
      const { orderId } = inputs.cancel_order.parse(input)
      const found = getOrder(deps.db, orderId)
      // The owner's own orders are not the trader's to touch: a stop-loss they set stays.
      if (found === undefined || found.agentId !== agentId || found.createdBy === 'owner') {
        return { content: { error: 'not_found' }, action: { tool: name, rejectReasons: [] } }
      }
      if (shadowOnLive(ctx)) {
        return {
          content: {
            refused: ['ORDERS_DISABLED'],
            why: 'a shadow trader leaves real orders alone',
          },
          action: { tool: name, rejectReasons: ['ORDERS_DISABLED'] },
        }
      }
      cancelOrder(deps, found, 'trader')
      return {
        content: getOrder(deps.db, orderId),
        action: { tool: name, orderId, rejectReasons: [] },
      }
    }
    case 'hold': {
      const { reason } = inputs.hold.parse(input)
      return { content: { ok: true }, hold: reason }
    }
  }
}

async function trade(ctx: TickContext, input: z.infer<typeof inputs.swap>): Promise<ToolOutcome> {
  const tokenIn = resolve(ctx, input.from)
  const tokenOut = resolve(ctx, input.to)
  if (!allowed(ctx, tokenIn) || !allowed(ctx, tokenOut)) {
    return refused('swap')
  }
  const req = {
    agentId: ctx.agentId,
    chain: ctx.chain,
    tokenIn,
    tokenOut,
    amountIn: input.amount,
    reason: clip(`AI trader: ${input.reason}`),
    ...(input.maxSlippageBps === undefined ? {} : { maxSlippageBps: input.maxSlippageBps }),
  }
  const intent = await swap(ctx.deps, req, undefined, {
    shadow: ctx.shadow,
    guard: ctx.guard,
  })
  const { id: intentId, status, rejectReasons } = intent
  return {
    content: { intentId, status, rejectReasons },
    action: { tool: 'swap', intentId, status, rejectReasons },
  }
}

async function order(
  ctx: TickContext,
  input: z.infer<typeof inputs.place_order>,
): Promise<ToolOutcome> {
  const token = resolve(ctx, input.token)
  if (!allowed(ctx, token)) {
    return refused('place_order')
  }
  // A fill sells for real on a live agent, so a shadow trader there cannot place one.
  if (shadowOnLive(ctx)) {
    return {
      content: { refused: ['ORDERS_DISABLED'], why: 'orders are off for a trader in shadow mode' },
      action: { tool: 'place_order', rejectReasons: ['ORDERS_DISABLED'] },
    }
  }
  const { triggerUsd, ...rest } = input
  const placed = placeOrder(
    ctx.deps,
    {
      ...rest,
      token,
      agentId: ctx.agentId,
      chain: ctx.chain,
      triggerOut: toAmount(parseDollars(triggerUsd)),
    },
    'agent',
  )
  if (Array.isArray(placed)) {
    return {
      content: { refused: placed },
      action: { tool: 'place_order', rejectReasons: placed },
    }
  }
  return {
    content: placed,
    action: { tool: 'place_order', orderId: placed.id, rejectReasons: [] },
  }
}
