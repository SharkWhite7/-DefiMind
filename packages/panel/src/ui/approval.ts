import { chainName } from '../domain/chains.js'
import { amountText, formatUsd } from '../domain/money.js'
import { FLAGS, isBuy, percent, swapTitle, units } from '../domain/trading.js'
import type { ApprovalView } from '../adapters/schemas.js'
import type { Context, Screen } from './context.js'
import { button, card, el, row, when } from './dom.js'

const gone = (ctx: Context) => [
  el('h1', {}, 'Not waiting any more'),
  el('p', {}, 'It was decided, or it expired.'),
  button('Back to overview', async () => ctx.go({ name: 'overview' })),
]

function decide(ctx: Context, approve: () => Promise<unknown>, reject: () => Promise<unknown>) {
  const done = async (message: string) => {
    await ctx.go({ name: 'overview' })
    ctx.say(message, 'done')
  }
  return el(
    'div',
    { class: 'actions' },
    button(
      'Reject',
      async () => {
        await reject()
        await done('Rejected.')
      },
      'danger',
    ),
    button(
      'Approve with passkey',
      async () => {
        await approve()
        await done('Approved.')
      },
      'primary',
    ),
  )
}

const mono = (text: string) => el('span', { class: 'mono' }, text)

/** Both sides of a swap in full, and the limits its quote must keep to. */
function swapRows({ chain, token, amount, swap }: ApprovalView['intent']) {
  if (swap === undefined) {
    return []
  }
  const buy = isBuy({ chain, token })
  return [
    row(
      buy ? 'Spends' : 'Sells',
      buy ? amountText({ chain, token, amount }) : mono(units(amount, token)),
    ),
    row(buy ? 'Buys' : 'For', mono(swap.tokenOut)),
    row('Receives at least', mono(units(swap.minAmountOut, swap.tokenOut))),
    row('Slippage', `up to ${percent(swap.slippageBps)}`),
    row('Price impact', percent(swap.priceImpactBps)),
    row('Venue', swap.venue),
    row('Quoted', when(swap.quotedAt)),
  ]
}

const flagText = (flag: string) => {
  const meaning = FLAGS[flag]
  return meaning === undefined ? flag : `${flag}: ${meaning}`
}

export async function approval(ctx: Context, id: string): Screen {
  const found = (await ctx.api.overview()).pending.find(({ intent }) => intent.id === id)
  if (!found) {
    return gone(ctx)
  }
  const { intent, simulation, flags, approveBefore } = found
  const swap = intent.kind === 'swap'
  return [
    el('h1', {}, swap ? swapTitle(intent) : amountText(intent)),
    card(
      el(
        'dl',
        {},
        row('Agent', intent.agentId),
        row('Chain', el('span', { class: 'pill chain' }, chainName(intent.chain))),
        ...swapRows(intent),
        !swap && row(intent.kind === 'x402' ? 'Pays' : 'To', mono(intent.recipient)),
        intent.domain !== undefined && row('For', intent.domain),
        row('Agent says', intent.reason),
        row('Simulation', simulation.summary),
        row('Decide before', when(approveBefore)),
      ),
      ...flags.map((flag) => el('p', { class: 'flag' }, flagText(flag))),
    ),
    decide(
      ctx,
      () => ctx.api.approveIntent(id),
      () => ctx.api.rejectIntent(id),
    ),
  ]
}

export async function mandate(ctx: Context, id: string): Screen {
  const found = (await ctx.api.overview()).mandates.find(({ mandate }) => mandate.id === id)
  if (!found) {
    return gone(ctx)
  }
  const { mandate: task, approveBefore, ttlSeconds } = found
  const list = (items: string[]) => (items.length === 0 ? 'none' : items.join(', '))
  return [
    el('h1', {}, `Task budget ${formatUsd(task.budget)}`),
    card(
      el(
        'dl',
        {},
        row('Agent', task.agentId),
        row('Agent says', task.reason),
        row('Domains', list(task.domains)),
        row('Recipients', el('span', { class: 'mono' }, list(task.recipients))),
        ttlSeconds !== undefined &&
          row('Lasts', `${Math.ceil(ttlSeconds / 60)} minutes once approved`),
        row('Decide before', when(approveBefore)),
      ),
      el('p', { class: 'muted' }, "A task budget only spends inside the agent's policy."),
    ),
    decide(
      ctx,
      () => ctx.api.approveMandate(id),
      () => ctx.api.rejectMandate(id),
    ),
  ]
}
