import type { TraderView } from '../adapters/schemas.js'
import { ApiError } from '../adapters/api.js'
import { formatUsd } from '../domain/money.js'
import { href } from '../domain/route.js'
import { count, PAUSED_BY, signedUsd } from '../domain/trader.js'
import { units } from '../domain/trading.js'
import type { Context, Screen } from './context.js'
import { button, card, el, row } from './dom.js'
import { feed } from './trader-feed.js'
import { setup } from './trader-setup.js'

const STATE = { off: 'Off', running: 'Running', paused: 'Paused' } as const
const TONE = { off: '', running: 'ok', paused: 'wait' } as const

/** Where it stands today: on or off, the key's presence, and what it used of its daily caps. */
function statusCard(ctx: Context, agentId: string, trader: TraderView) {
  const { state, config, today, report } = trader
  const why = trader.pausedBy === undefined ? '' : ` ${PAUSED_BY[trader.pausedBy] ?? ''}`
  return card(
    el('h2', { class: `pill ${TONE[state]}` }, `${STATE[state]}${why}`),
    report.shadow && el('p', { class: 'flag' }, 'Shadow: nothing was traded.'),
    el(
      'dl',
      {},
      row('Anthropic API key', trader.keySet ? 'Set' : 'Not set'),
      row('Checks today', `${today.ticks} of ${config.maxTicksPerDay}`),
      row('API tokens today', `${count(today.tokens)} of ${count(config.maxTokensPerDay)}`),
    ),
    state === 'running' &&
      button('Pause trader', async () => {
        await ctx.api.pauseTrader(agentId)
        await ctx.go({ name: 'trader', id: agentId }, true)
        ctx.say('Trader paused.', 'done')
      }),
    state === 'paused' &&
      button(
        'Resume with passkey',
        async () => {
          await ctx.api.resumeTrader(agentId)
          await ctx.go({ name: 'trader', id: agentId }, true)
          ctx.say('Trader resumed.', 'done')
        },
        'primary',
      ),
  )
}

/** What it holds and what it made or lost, landed only: never a projection. */
function reportCard({ report }: TraderView) {
  return card(
    el('h2', {}, 'Results'),
    el(
      'dl',
      {},
      row(report.shadow ? 'Trades it would have made' : 'Trades', String(report.trades)),
      !report.shadow &&
        report.realizedPnlUsd !== undefined &&
        row('Realized profit or loss', signedUsd(report.realizedPnlUsd, formatUsd)),
    ),
    report.positions.length === 0 && el('p', { class: 'muted' }, 'Holds no tokens.'),
    ...report.positions.map((p) =>
      el(
        'div',
        { class: 'item' },
        el('strong', { class: 'mono' }, units(p)),
        el('span', {}, `Cost ${formatUsd(p.cost)}`),
      ),
    ),
  )
}

/** A guard-core before GC-73 has no trader: that is not an error. */
const read = (ctx: Context, id: string) =>
  ctx.api.trader(id).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) {
      return null
    }
    throw error
  })

async function one(ctx: Context, agentId: string): Screen {
  const [trader, policy] = await Promise.all([read(ctx, agentId), ctx.api.policy(agentId)])
  const head = el('h1', {}, `AI Trader · ${agentId}`)
  if (trader === null) {
    return [head, card(el('p', {}, 'The AI trader is not available on this DefiMind yet.'))]
  }
  return [
    head,
    el(
      'p',
      { class: 'muted' },
      "It decides with a Claude model, inside this agent's rules and limits. Not financial advice.",
    ),
    statusCard(ctx, agentId, trader),
    reportCard(trader),
    setup(ctx, trader, policy),
    await feed(ctx, agentId),
  ]
}

/** CR-027: one trader per agent. With one agent, straight to it. */
export async function trader(ctx: Context, id?: string): Screen {
  if (id !== undefined) {
    return one(ctx, id)
  }
  const { agents } = await ctx.api.agents()
  if (agents.length === 1) {
    return one(ctx, agents[0]!.agentId)
  }
  return [
    el('h1', {}, 'AI Trader'),
    agents.length === 0 && el('p', {}, 'Connect an agent first.'),
    ...agents.map((a) =>
      el(
        'a',
        { href: href({ name: 'trader', id: a.agentId }), class: 'item' },
        el('strong', {}, a.agentId),
      ),
    ),
  ]
}
