import type { Order } from '../adapters/api.js'
import type { QuoteView, TokenRiskView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { isSolana } from '../domain/guide.js'
import { formatUsd, parseDollars } from '../domain/money.js'
import { href } from '../domain/route.js'
import { parseUnits } from '../domain/tokens.js'
import { FLAGS, percent, units } from '../domain/trading.js'
import { getAddress } from '@defimind/shared'
import type { Context, Screen } from './context.js'
import { button, card, el, row, when } from './dom.js'
import { tokenIcon } from './risk.js'
import { ownerTrading } from './token-search.js'

const mono = (text: string) => el('span', { class: 'mono' }, text)
const figure = (text: string) => el('span', { class: 'figures' }, text)

function select(id: string, options: [string, string][]) {
  const node = el('select', { id })
  node.append(...options.map(([value, label]) => el('option', { value }, label)))
  return node
}

/** One side of a swap: the chain's dollar, or a token with the decimals read onchain. */
type Leg = TokenRiskView | undefined

/** The symbol, if the quote has one, is the venue's: it sits beside the whole mint. */
const show = (leg: Leg, amount: string, symbol: string | undefined) =>
  leg === undefined
    ? formatUsd(amount)
    : units({ amount, token: leg.mint, decimals: leg.decimals, symbol })

const VERB = { buy: 'Spends', sell: 'Sells', swap: 'Swaps' } as const

/** The exact amounts the passkey will confirm: what goes in, and the least that must come out. */
function confirmCard(
  ctx: Context,
  order: Order,
  quote: QuoteView,
  legs: { side: keyof typeof VERB; from: Leg; to: Leg },
  back: () => void,
) {
  const { from, to } = legs
  return card(
    el('h2', {}, 'Confirm'),
    el(
      'dl',
      {},
      row(VERB[legs.side], mono(show(from, quote.amountIn, quote.symbolIn))),
      row('Receives at least', mono(show(to, quote.minAmountOut, quote.symbolOut))),
      row('Quoted to receive', mono(show(to, quote.expectedOut, quote.symbolOut))),
      row('Slippage', figure(`up to ${percent(quote.slippageBps)}`)),
      row('Price impact', figure(percent(quote.priceImpactBps))),
      row(
        'Selling it back now',
        quote.exitImpactBps === null
          ? 'No route found'
          : figure(`${percent(quote.exitImpactBps)} price impact`),
      ),
      row('Quoted by', quote.venue),
      row('Quoted', when(quote.quotedAt)),
    ),
    ...quote.risks.map((code) =>
      el('p', { class: 'flag' }, `This trade would be refused: ${code}.`),
    ),
    ...quote.flags.map((flag) => el('p', { class: 'flag' }, `${flag}: ${FLAGS[flag] ?? flag}`)),
    el(
      'p',
      { class: 'muted' },
      "Your passkey confirms these exact amounts. guard-core quotes again before it signs: if it cannot still get at least this much, the trade is refused. It counts in this agent's day and goes through every check of its rules.",
    ),
    el(
      'div',
      { class: 'actions' },
      button('Change', async () => back()),
      button(
        'Trade with passkey',
        async () => {
          const done = await ctx.api.trade({ ...order, minAmountOut: quote.minAmountOut })
          const why = done.rejectReasons.length > 0 ? `: ${done.rejectReasons.join(', ')}` : ''
          ctx.say(`Trade ${done.status}${why}.`, done.status === 'rejected' ? 'stop' : 'done')
        },
        'primary',
      ),
    ),
  )
}

/** A labelled token select, its icon following the chosen mint. */
function picker(id: string, label: string, mints: string[]) {
  const node = select(
    id,
    mints.map((mint) => [mint, mint]),
  )
  const icon = el('div', {}, tokenIcon(node.value))
  node.addEventListener('change', () => icon.replaceChildren(tokenIcon(node.value)))
  const field = el(
    'div',
    {},
    el('label', { for: id }, label),
    el('div', { class: 'token' }, icon, node),
  )
  return { select: node, field }
}

/** CR-025: the owner trades for one agent, by hand, inside that agent's rules. */
export async function manualTrade(ctx: Context, agentId: string): Screen {
  const [policy, { chains }, portfolio] = await Promise.all([
    ctx.api.policy(agentId),
    ctx.api.settings(),
    ctx.api.portfolio().catch(() => undefined),
  ])
  const chain = chains.map((c) => c.chain).find((c) => isSolana(c) && policy.chains.includes(c))
  const usd = chain === undefined ? undefined : getAddress(chain, 'usd')
  const tokens = policy.trading?.enabled === true ? policy.trading.tokens : []
  const head = [
    el('h1', {}, `Trade for ${agentId}`),
    el('a', { href: href({ name: 'agent', id: agentId }) }, `Back to ${agentId}`),
  ]
  if (chain !== undefined && !(await ownerTrading(ctx, chain))) {
    return [...head, card(el('p', {}, 'Trading by hand is not available on this DefiMind yet.'))]
  }
  if (chain === undefined || usd === undefined || tokens.length === 0) {
    return [
      ...head,
      card(
        el(
          'p',
          {},
          'Turn trading on and allow at least one token for this agent first, in its Trading settings. Trading runs on Solana only.',
        ),
      ),
    ]
  }
  // CR-026: a swap spends only what the agent holds, into any token its rules allow.
  const held = (portfolio?.agents.find((a) => a.agentId === agentId)?.positions ?? []).filter(
    (p) => p.chain === chain,
  )
  const side = select('side', [
    ['buy', 'Buy with dollars'],
    ['sell', 'Sell back to dollars'],
    ...(held.length > 0 ? [['swap', 'Swap a token it holds for another'] as [string, string]] : []),
  ])
  const token = picker('token', 'Token (mint address)', tokens)
  const from = picker(
    'from',
    'From, a token it holds',
    held.map((p) => p.token),
  )
  const to = picker('to', 'To, a token it may buy', tokens)
  const amount = el('input', { id: 'amount', inputmode: 'decimal', autocomplete: 'off' })
  const label = el('label', { for: 'amount' }, 'Spend, in dollars')
  const swapping = () => side.value === 'swap'
  const update = () => {
    label.textContent = side.value === 'buy' ? 'Spend, in dollars' : "Amount, in the token's units"
    token.field.hidden = swapping()
    from.field.hidden = !swapping()
    to.field.hidden = !swapping()
  }
  side.addEventListener('change', update)
  update()
  const slot = el('div')
  const form = card(
    el('h2', {}, `On ${chainName(chain)}`),
    el('label', { for: 'side' }, 'Trade'),
    side,
    token.field,
    from.field,
    to.field,
    label,
    amount,
    button(
      'Get quote',
      async () => {
        const kind = side.value === 'swap' ? 'swap' : side.value === 'sell' ? 'sell' : 'buy'
        const [tokenIn, tokenOut] =
          kind === 'buy'
            ? [usd, token.select.value]
            : kind === 'sell'
              ? [token.select.value, usd]
              : [from.select.value, to.select.value]
        if (tokenIn === tokenOut) {
          ctx.say('Choose two different tokens.', 'stop')
          return
        }
        const risk = (mint: string) =>
          mint === usd ? Promise.resolve(undefined) : ctx.api.tokenRisk(mint, chain)
        const [legIn, legOut] = await Promise.all([risk(tokenIn), risk(tokenOut)])
        const amountIn =
          legIn === undefined
            ? parseDollars(amount.value)
            : parseUnits(amount.value, legIn.decimals)
        if (amountIn === undefined || amountIn === '0') {
          ctx.say(
            kind === 'buy'
              ? 'Write an amount in dollars, like 5.00.'
              : 'Write an amount of the token, like 1.5.',
            'stop',
          )
          return
        }
        const order: Order = { agentId, chain, tokenIn, tokenOut, amountIn }
        const quote = await ctx.api.quote(order)
        form.hidden = true
        const legs = { side: kind, from: legIn, to: legOut } as const
        slot.replaceChildren(
          confirmCard(ctx, order, quote, legs, () => {
            slot.replaceChildren()
            form.hidden = false
          }),
        )
      },
      'primary',
    ),
  )
  return [
    ...head,
    el(
      'p',
      { class: 'muted' },
      "A trade by hand follows this agent's rules and limits, and always asks for your passkey.",
    ),
    form,
    slot,
  ]
}
