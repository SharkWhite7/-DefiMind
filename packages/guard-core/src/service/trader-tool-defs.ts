import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages'

/** The tools that act; read tools never count toward maxActionsPerTick. */
export const ACTIONS = new Set(['swap', 'place_order', 'cancel_order'])

const mint = {
  type: 'string',
  description: 'A token mint address, "USDC" for the dollar or "SOL" for SOL.',
}
const amount = {
  type: 'string',
  description: 'Atomic units of the token spent, as a decimal integer string.',
}
const slippage = {
  type: 'integer',
  description: 'Optional slippage ceiling in basis points; the policy limit applies anyway.',
}
const reason = { type: 'string', description: 'Why, in one or two plain sentences.' }

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): BetaTool {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: 'object', properties, required, additionalProperties: false },
  }
}

/**
 * Strict schemas carry no length or range limits (the API refuses them), so every input is also
 * parsed with zod before it runs.
 */
export const TOOLS: BetaTool[] = [
  tool('get_portfolio', "The agent's positions at cost and the day's trade budget.", {}, []),
  tool(
    'quote',
    'A read-only quote: what `amount` of `from` would bring in `to` now. Trades nothing.',
    { from: mint, to: mint, amount },
    ['from', 'to', 'amount'],
  ),
  tool(
    'token_risk',
    "A token's mint facts (freeze and mint authority, extensions, exit route) and the venue's own claims.",
    { mint: { type: 'string', description: 'The token mint address.' } },
    ['mint'],
  ),
  tool(
    'recent_prices',
    'Up to 96 price samples { at, priceUsd } from the last 24 hours, oldest first.',
    { mint: { type: 'string', description: 'The token mint address.' } },
    ['mint'],
  ),
  tool(
    'swap',
    "Trades `amount` of `from` for `to` through the agent's policy. Answers the intent's status and any reasons it was refused.",
    { from: mint, to: mint, amount, maxSlippageBps: slippage, reason },
    ['from', 'to', 'amount', 'reason'],
  ),
  tool(
    'place_order',
    'A take-profit or stop-loss that sells `amount` of `token` for the dollar once the whole order would bring `triggerUsd` (at or above for take_profit, at or below for stop_loss).',
    {
      token: { type: 'string', description: 'The token mint address.' },
      kind: { type: 'string', enum: ['take_profit', 'stop_loss'] },
      amount: { type: 'string', description: 'Atomic units of the token to sell.' },
      triggerUsd: { type: 'string', description: 'A decimal dollar amount, e.g. "12.50".' },
      maxSlippageBps: slippage,
    },
    ['token', 'kind', 'amount', 'triggerUsd'],
  ),
  tool('cancel_order', "Cancels one of the agent's open orders.", { orderId: { type: 'string' } }, [
    'orderId',
  ]),
  tool(
    'hold',
    'Ends this tick with no further action. Use it when nothing should be done.',
    { reason },
    ['reason'],
  ),
]
