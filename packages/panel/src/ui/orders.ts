import { ApiError } from '../adapters/api.js'
import type { OrderView, PolicyView, PortfolioView } from '../adapters/schemas.js'
import { formatUsd } from '../domain/money.js'
import {
  fromOrderForm,
  type NewOrder,
  ORDER_KINDS,
  ORDER_STATUS,
  orderFloor,
  REFUSALS,
  WHEN,
} from '../domain/orders.js'
import { isSolana } from '../domain/guide.js'
import { href } from '../domain/route.js'
import { percent, units } from '../domain/trading.js'
import type { Context, Screen } from './context.js'
import { button, card, el, row, when } from './dom.js'
import { tokenIcon } from './risk.js'

type Position = PortfolioView['positions'][number]

const mono = (text: string) => el('span', { class: 'mono' }, text)

function select(id: string, options: [string, string][]) {
  const node = el('select', { id })
  node.append(...options.map(([value, label]) => el('option', { value }, label)))
  return node
}

const amountOf = (order: OrderView, held: Position | undefined) =>
  units({
    amount: order.amount,
    token: order.token,
    decimals: held?.decimals,
    symbol: held?.symbol,
  })

function orderItem(ctx: Context, order: OrderView, held: Position | undefined) {
  const open = order.status === 'open'
  return el(
    'div',
    { class: 'item' },
    el('strong', {}, `${ORDER_KINDS[order.kind]}: ${ORDER_STATUS[order.status]}`),
    el(
      'dl',
      {},
      row('Sells', mono(amountOf(order, held))),
      row(WHEN[order.kind], mono(formatUsd(order.triggerOut))),
      row('Receives at least', mono(formatUsd(orderFloor(order.triggerOut, order.maxSlippageBps)))),
      row('Placed by', order.createdBy === 'owner' ? 'You' : 'The agent'),
      row('Placed', when(order.createdAt)),
      order.expiresAt !== undefined && row('Expires', when(order.expiresAt)),
      order.failReason !== undefined && row('Why not', order.failReason),
      order.filledIntentId !== undefined &&
        row('Sale', el('a', { href: href({ name: 'executions' }) }, 'In Executions')),
    ),
    open &&
      button('Cancel order', async () => {
        await ctx.api.cancelOrder(order.id)
        await ctx.go({ name: 'orders', id: order.agentId }, true)
        ctx.say('Order cancelled.', 'done')
      }),
  )
}

/** What the passkey will sign, in full, before it is asked for. */
function confirmCard(
  ctx: Context,
  agentId: string,
  held: Position,
  order: NewOrder,
  back: () => void,
) {
  return card(
    el('h2', {}, `Confirm: ${ORDER_KINDS[order.kind]}`),
    el(
      'dl',
      {},
      row('Sells', mono(units({ ...held, amount: order.amount }))),
      row(WHEN[order.kind], mono(formatUsd(order.triggerOut))),
      row('Slippage', `up to ${percent(order.maxSlippageBps)}`),
      row('Receives at least', mono(formatUsd(orderFloor(order.triggerOut, order.maxSlippageBps)))),
    ),
    el(
      'p',
      { class: 'muted' },
      "guard-core checks the price every few seconds and sells only after several checks in a row agree. The sale goes through every check of this agent's rules. If it cannot get at least this much, nothing is sold and you are told.",
    ),
    el(
      'div',
      { class: 'actions' },
      button('Change', async () => back()),
      button(
        'Place order with passkey',
        async () => {
          try {
            await ctx.api.placeOrder({ agentId, chain: held.chain, token: held.token, ...order })
          } catch (error) {
            if (error instanceof ApiError && error.code === 'order_refused') {
              const why = error.reasons.map((code) => REFUSALS[code] ?? code).join(' ')
              ctx.say(`Order refused. ${why}`, 'stop')
              return
            }
            throw error
          }
          await ctx.go({ name: 'orders', id: agentId }, true)
          ctx.say('Order placed. Confirmed with your passkey.', 'done')
        },
        'primary',
      ),
    ),
  )
}

function newOrder(ctx: Context, agentId: string, positions: Position[], maxSlippageBps: number) {
  const token = select(
    'order-token',
    positions.map((p) => [p.token, units(p)]),
  )
  const kind = select('order-kind', [
    ['take_profit', 'Take profit: sell when the price rises'],
    ['stop_loss', 'Stop loss: sell when the price falls'],
  ])
  const amount = el('input', { id: 'order-amount', inputmode: 'decimal', autocomplete: 'off' })
  const trigger = el('input', { id: 'order-trigger', inputmode: 'decimal', autocomplete: 'off' })
  const slippage = el('input', { id: 'order-slippage', inputmode: 'decimal', autocomplete: 'off' })
  slippage.placeholder = (maxSlippageBps / 100).toFixed(2)
  const icon = el('div', {}, tokenIcon(token.value))
  token.addEventListener('change', () => icon.replaceChildren(tokenIcon(token.value)))
  const slot = el('div')
  const form = card(
    el('h2', {}, 'New order'),
    el('label', { for: 'order-token' }, 'Token it holds'),
    el('div', { class: 'token' }, icon, token),
    el('label', { for: 'order-kind' }, 'Kind'),
    kind,
    el('label', { for: 'order-amount' }, "Amount to sell, in the token's units"),
    amount,
    el('label', { for: 'order-trigger' }, 'Sell when the whole amount is worth, in dollars'),
    trigger,
    el('label', { for: 'order-slippage' }, 'Slippage, in percent (empty: the agent’s own)'),
    slippage,
    button(
      'Review order',
      async () => {
        const held = positions.find((p) => p.token === token.value)!
        const order = fromOrderForm(
          {
            kind: kind.value,
            amount: amount.value,
            trigger: trigger.value,
            slippage: slippage.value,
          },
          held.decimals,
          maxSlippageBps,
        )
        if (typeof order === 'string') {
          ctx.say(order, 'stop')
          return
        }
        form.hidden = true
        slot.replaceChildren(
          confirmCard(ctx, agentId, held, order, () => {
            slot.replaceChildren()
            form.hidden = false
          }),
        )
      },
      'primary',
    ),
  )
  return [form, slot]
}

/** A guard-core older than CR-026 has no orders route: that is no orders, not an error. */
const read = (ctx: Context) =>
  ctx.api.orders().catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) {
      return undefined
    }
    throw error
  })

function placing(ctx: Context, agentId: string, policy: PolicyView, positions: Position[]) {
  const trading = policy.trading
  if (trading?.enabled !== true || trading.orders?.enabled !== true) {
    return [
      card(
        el(
          'p',
          {},
          "Orders are off for this agent. Turn them on in its Trading limits, on the agent's page.",
        ),
      ),
    ]
  }
  if (positions.length === 0) {
    return [card(el('p', {}, 'This agent holds no tokens. An order sells what it holds.'))]
  }
  return newOrder(ctx, agentId, positions, trading.maxSlippageBps)
}

/** CR-026: the owner's take-profit and stop-loss orders for one agent, and the agent's own. */
export async function ordersScreen(ctx: Context, agentId: string): Screen {
  const head = [
    el('h1', {}, `Orders for ${agentId}`),
    el('a', { href: href({ name: 'agent', id: agentId }) }, `Back to ${agentId}`),
  ]
  const [data, policy, portfolio] = await Promise.all([
    read(ctx),
    ctx.api.policy(agentId),
    ctx.api.portfolio().catch(() => undefined),
  ])
  if (data === undefined) {
    return [...head, card(el('p', {}, 'Orders are not available on this DefiMind yet.'))]
  }
  const positions = portfolio?.agents.find((a) => a.agentId === agentId)?.positions ?? []
  const solana = positions.filter((p) => isSolana(p.chain))
  const mine = data.orders.filter((o) => o.agentId === agentId)
  const live = mine.filter((o) => o.status === 'open' || o.status === 'triggered')
  const past = mine.filter((o) => !live.includes(o))
  const held = (o: OrderView) => positions.find((p) => p.token === o.token && p.chain === o.chain)
  return [
    ...head,
    el(
      'p',
      { class: 'muted' },
      'An order sells a token back to dollars when its price gets where you set it. Placing one asks for your passkey; cancelling does not.',
    ),
    ...placing(ctx, agentId, policy, solana),
    card(
      el('h2', {}, 'Open orders'),
      live.length === 0 && el('p', { class: 'muted' }, 'None.'),
      ...live.map((o) => orderItem(ctx, o, held(o))),
    ),
    past.length > 0 &&
      card(el('h2', {}, 'Past orders'), ...past.map((o) => orderItem(ctx, o, held(o)))),
  ]
}
