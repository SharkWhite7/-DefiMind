import type { PolicyView } from '../adapters/schemas.js'
import { fromLimitsForm, KIND_NAMES, KINDS, toLimitsForm, withLimits } from '../domain/limits.js'
import type { Context } from './context.js'
import { button, card, el } from './dom.js'
import { tokenIcon } from './risk.js'

type Save = (after: PolicyView, message: string) => Promise<void>

function money(id: string, label: string, value: string) {
  const node = el('input', {
    id,
    inputmode: 'decimal',
    autocomplete: 'off',
    placeholder: 'default',
  })
  node.value = value
  return { node, nodes: [el('label', { for: id }, label), node] }
}

/**
 * CR-026: limits per token and per kind of trade, and the agent's own take-profit and stop-loss
 * orders. Empty means the agent's default. Raising, adding or removing one asks for the passkey.
 */
export function tradingLimits(ctx: Context, policy: PolicyView, save: Save) {
  const trading = policy.trading
  if (trading === undefined) {
    return false
  }
  const form = toLimitsForm(trading, trading.tokens)
  const tokens = trading.tokens.map((mint, i) => ({
    mint,
    buy: money(`tl-buy-${i}`, 'Most per buy, in dollars', form.tokens[mint]?.maxBuy ?? ''),
    held: money(`tl-held-${i}`, 'Most held at cost, in dollars', form.tokens[mint]?.maxHeld ?? ''),
  }))
  const kinds = KINDS.map((kind) => ({
    kind,
    trade: money(
      `op-${kind}`,
      `${KIND_NAMES[kind]}: one trade, in dollars`,
      form.operations[kind].trade,
    ),
    daily: money(
      `op-${kind}-day`,
      `${KIND_NAMES[kind]}: daily total, in dollars`,
      form.operations[kind].daily,
    ),
  }))
  const orders = el('input', { id: 'orders', type: 'checkbox' })
  orders.checked = form.ordersEnabled
  const maxOpen = el('input', { id: 'max-open', inputmode: 'numeric', autocomplete: 'off' })
  maxOpen.value = form.maxOpen
  return card(
    el('h2', {}, 'Trading limits'),
    el(
      'p',
      { class: 'muted' },
      'Leave a field empty to use the default. Adding, raising or removing a limit asks for your passkey.',
    ),
    el('h3', {}, 'Per token'),
    tokens.length === 0 && el('p', { class: 'muted' }, 'Allow a token first.'),
    ...tokens.flatMap(({ mint, buy, held }) => [
      el('div', { class: 'token' }, tokenIcon(mint), el('span', { class: 'mono' }, mint)),
      ...buy.nodes,
      ...held.nodes,
    ]),
    el('h3', {}, 'Per kind of trade'),
    el(
      'p',
      { class: 'muted' },
      'Empty: buys use the limits above, sells are not capped, swaps use the buy limits.',
    ),
    ...kinds.flatMap(({ trade, daily }) => [...trade.nodes, ...daily.nodes]),
    el('h3', {}, 'Orders'),
    el('label', { class: 'check' }, orders, 'Allow take-profit and stop-loss orders'),
    el('label', { for: 'max-open' }, 'Most open orders'),
    maxOpen,
    button(
      'Save limits',
      async () => {
        const limits = fromLimitsForm({
          tokens: Object.fromEntries(
            tokens.map(({ mint, buy, held }) => [
              mint,
              { maxBuy: buy.node.value, maxHeld: held.node.value },
            ]),
          ),
          operations: Object.fromEntries(
            kinds.map(({ kind, trade, daily }) => [
              kind,
              { trade: trade.node.value, daily: daily.node.value },
            ]),
          ) as Parameters<typeof fromLimitsForm>[0]['operations'],
          ordersEnabled: orders.checked,
          maxOpen: maxOpen.value,
        })
        if (typeof limits === 'string') {
          ctx.say(limits, 'stop')
          return
        }
        await save({ ...policy, trading: withLimits(trading, limits) }, 'Limits saved.')
      },
      'primary',
    ),
  )
}
