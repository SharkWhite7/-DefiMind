import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { GuardError } from '../adapters/guard.js'
import type { PlacedOrder } from '../adapters/trading.js'
import { chainName } from '../domain/chains.js'
import { adviceFor, explainReject } from '../domain/explain.js'
import { formatUsd, formatAmount, parseUsd } from '../domain/usd.js'
import type { ToolDeps } from './deps.js'
import { failure, guarded, text } from './result.js'
import { noTradingYet } from './trading.js'

// Controls and limits only. A stop-loss is described as what it is: a sell that may not happen.
const PLACE_DESCRIPTION = `Leave a take-profit or stop-loss on a token the agent holds. DefiMind watches the price of the whole amount and, once it is at or above triggerUsd (take_profit) or at or below it (stop_loss) for several checks in a row, sells it back to USDC under every trading check.
A stop-loss is not a guarantee: if the sale would get less than triggerUsd minus slippage, it is refused and the tokens stay; the owner is told. Orders do not run while the agent is paused, and Close positions or a kill cancels them. Placing an order never waits for the owner. Place one only when the user asks for it. Solana only.`

const CANCEL_DESCRIPTION = `Cancel one of this agent's open take-profit or stop-loss orders by its id, from place_order or list_orders. Nothing is sold.`

const LIST_DESCRIPTION = `List this agent's take-profit and stop-loss orders: the open ones and the most recent others, with what each will sell, its trigger and its status. Read-only.`

const KIND: Record<PlacedOrder['kind'], { label: string; when: string }> = {
  take_profit: { label: 'Take-profit', when: 'at or above' },
  stop_loss: { label: 'Stop-loss', when: 'at or below' },
}

const STATUS: Record<PlacedOrder['status'], string> = {
  open: 'DefiMind is watching it. cancel_order removes it.',
  triggered: 'The trigger was met and the sell is being made.',
  filled: 'Sold.',
  cancelled: 'Cancelled; nothing was sold.',
  failed: 'Not sold; the tokens are still held.',
}

export function registerOrders(server: McpServer, deps: ToolDeps): void {
  const { guard, log, defaultChain } = deps

  server.registerTool(
    'place_order',
    {
      title: 'Place a take-profit or stop-loss',
      description: PLACE_DESCRIPTION,
      inputSchema: {
        token: z.string().min(1).max(128).describe('Mint address of the token held.'),
        kind: z.enum(['take_profit', 'stop_loss']),
        amount: z
          .string()
          .regex(/^[1-9]\d{0,39}$/, 'a whole number above zero')
          .describe('How much to sell, in the smallest units of the token (get_portfolio).'),
        triggerUsd: z
          .string()
          .describe('Dollars the whole amount must sell for, as a decimal string like "12.50".'),
        maxSlippageBps: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .optional()
          .describe(
            "Most slippage to accept on the sale, in basis points. Leave empty for the owner's limit.",
          ),
      },
      annotations: { openWorldHint: true },
    },
    async ({ token, kind, amount, triggerUsd, maxSlippageBps }) => {
      if (!defaultChain.startsWith('solana:')) {
        return failure(
          `Orders work on Solana only for now, not on ${chainName(defaultChain)} (${defaultChain}).`,
        )
      }
      const trigger = parseUsd(triggerUsd)
      if (!trigger.ok) {
        return failure(`triggerUsd: ${trigger.error}`)
      }
      if (trigger.atomic === 0n) {
        return failure('triggerUsd: a trigger must be more than zero.')
      }
      return guarded(log, async () => {
        try {
          const placed = await guard
            .placeOrder({
              chain: defaultChain,
              token,
              kind,
              amount,
              triggerOut: trigger.atomic.toString(),
              ...(maxSlippageBps === undefined ? {} : { maxSlippageBps }),
            })
            .catch(noTradingYet)
          return text(describeOrder(placed, deps))
        } catch (error) {
          // guard-core answers a refused order with 409 order_refused and its codes: a decision.
          if (error instanceof GuardError && error.rejectReasons.length > 0) {
            return text(refused(error.rejectReasons, formatUsd(trigger.atomic)))
          }
          throw error
        }
      })
    },
  )

  server.registerTool(
    'cancel_order',
    {
      title: 'Cancel an order',
      description: CANCEL_DESCRIPTION,
      inputSchema: { orderId: z.uuid().describe('The order id, from place_order or list_orders.') },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ orderId }) =>
      guarded(log, async () => {
        const cancelled = await guard.cancelOrder(orderId).catch((error: unknown) => {
          // Here a 404 is an order this agent does not have, the likeliest reading.
          if (error instanceof GuardError && error.httpStatus === 404) {
            throw new GuardError(
              'http',
              `This agent has no order ${orderId}. list_orders shows its orders.`,
              404,
            )
          }
          throw error
        })
        return text(describeOrder(cancelled, deps))
      }),
  )

  server.registerTool(
    'list_orders',
    {
      title: 'List orders',
      description: LIST_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(log, async () => {
        const orders = await guard.orders().catch(noTradingYet)
        if (orders.length === 0) {
          return text('No orders.')
        }
        const open = orders.filter((item) => item.status === 'open')
        const others = orders.filter((item) => item.status !== 'open').slice(0, 20)
        return text([...open, ...others].map((item) => describeOrder(item, deps)).join('\n\n'))
      }),
  )
}

function describeOrder(order: PlacedOrder, deps: ToolDeps): string {
  const { label, when } = KIND[order.kind]
  const dollar = deps.usd(order.chain)?.symbol ?? ''
  const lines = [
    `${label} ${order.id}: ${order.status}.`,
    `Sells ${order.amount} smallest units of ${order.token} when the whole amount would fetch ${when} ${formatAmount(order.triggerOut)} ${dollar}`.trimEnd() +
      `, with slippage up to ${order.maxSlippageBps} bps. Placed by the ${order.createdBy}, ${order.createdAt}${order.expiresAt === undefined ? '' : `; expires ${order.expiresAt}`}.`,
    STATUS[order.status],
  ]
  if (order.filledIntentId !== undefined) {
    lines.push(`The sale is intent ${order.filledIntentId}; check_intent shows it.`)
  }
  if (order.failReason !== undefined) {
    lines.push(`Reason: ${explainReject(order.failReason)}`, ...adviceFor([order.failReason]))
  }
  return lines.join('\n')
}

function refused(codes: readonly string[], trigger: string): string {
  return [
    `DefiMind refused this order (trigger ${trigger}); nothing was placed.`,
    'Reasons:',
    ...codes.map((code) => `- ${explainReject(code)}`),
    ...adviceFor(codes),
  ].join('\n')
}
