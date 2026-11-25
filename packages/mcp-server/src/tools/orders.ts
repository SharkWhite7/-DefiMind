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
const PLACE_DESCRIPTION = `Leave a take-profit, stop-loss or trailing stop on a token the agent holds. DefiMind watches the price of the whole amount and, once it is at or above triggerUsd (take_profit) or at or below it (stop_loss) for several checks in a row, sells it back to USDC under every trading check.
A trailing_stop takes trailBps instead: it sells once the whole amount falls that far below its high, where the high only moves after it has held for several checks. Its triggerUsd is an optional floor.
A stop is not a guarantee: if the sale would get less than its trigger minus slippage, nothing is sold, the tokens stay, the order keeps watching, and the owner is told. Orders do not run while the agent is paused, and Close positions or a kill cancels them. Placing an order never waits for the owner. Place one only when the user asks for it. Solana only.`

const CANCEL_DESCRIPTION = `Cancel one of this agent's own open orders by its id, from place_order or list_orders. Nothing is sold. Orders the owner placed are the owner's to cancel.`

const LIST_DESCRIPTION = `List this agent's orders: the open ones and the most recent others, with what each will sell, its trigger and its status. Read-only.`

const KIND: Record<PlacedOrder['kind'], { label: string; when: string }> = {
  take_profit: { label: 'Take-profit', when: 'at or above' },
  stop_loss: { label: 'Stop-loss', when: 'at or below' },
  trailing_stop: { label: 'Trailing stop', when: 'at or below' },
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
        kind: z.enum(['take_profit', 'stop_loss', 'trailing_stop']),
        amount: z
          .string()
          .regex(/^[1-9]\d{0,39}$/, 'a whole number above zero')
          .describe('How much to sell, in the smallest units of the token (get_portfolio).'),
        triggerUsd: z
          .string()
          .optional()
          .describe(
            'Dollars the whole amount must sell for, as a decimal string like "12.50". Optional for a trailing_stop, where it is a floor.',
          ),
        trailBps: z
          .number()
          .int()
          .min(100)
          .max(5000)
          .optional()
          .describe(
            'trailing_stop only: how far below its high it sells, in basis points (1000 = 10%).',
          ),
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
    async ({ token, kind, amount, triggerUsd, maxSlippageBps, trailBps }) => {
      if (!defaultChain.startsWith('solana:')) {
        return failure(
          `Orders work on Solana only for now, not on ${chainName(defaultChain)} (${defaultChain}).`,
        )
      }
      const trailing = kind === 'trailing_stop'
      if (trailing !== (trailBps !== undefined)) {
        return failure('trailBps: give it for a trailing_stop, and only for one.')
      }
      const trigger = parseUsd(triggerUsd ?? (trailing ? '0' : ''))
      if (!trigger.ok) {
        return failure(`triggerUsd: ${trigger.error}`)
      }
      if (trigger.atomic === 0n && !trailing) {
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
              ...(trailBps === undefined ? {} : { trailBps }),
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

/** The level it sells at, as guard-core works it out: a trailing stop's follows its high. */
function triggerOf(order: PlacedOrder): bigint {
  const floor = BigInt(order.triggerOut)
  if (order.kind !== 'trailing_stop' || order.peakOut === undefined) {
    return floor
  }
  const trailed = (BigInt(order.peakOut) * BigInt(10_000 - (order.trailBps ?? 0))) / 10_000n
  return trailed > floor ? trailed : floor
}

function describeOrder(order: PlacedOrder, deps: ToolDeps): string {
  const { label, when } = KIND[order.kind]
  const dollar = deps.usd(order.chain)?.symbol ?? ''
  const trail =
    order.trailBps === undefined
      ? []
      : [
          `Trails its high by ${order.trailBps} bps; confirmed high ${order.peakOut === undefined ? 'not set yet' : `${formatAmount(order.peakOut)} ${dollar}`.trimEnd()}.`,
        ]
  const lines = [
    `${label} ${order.id}: ${order.status}.`,
    ...trail,
    (triggerOf(order) === 0n
      ? `Sells ${order.amount} smallest units of ${order.token} once it has a confirmed high to trail; no level yet`
      : `Sells ${order.amount} smallest units of ${order.token} when the whole amount would fetch ${when} ${formatAmount(triggerOf(order).toString())} ${dollar}`.trimEnd()) +
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
