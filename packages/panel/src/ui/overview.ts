import type { Overview } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { amountText, formatUsd } from '../domain/money.js'
import { href, type Route } from '../domain/route.js'
import type { Context, Screen } from './context.js'
import { card, el, when } from './dom.js'

const link = (route: Route, ...children: (Node | string)[]) =>
  el('a', { href: href(route), class: 'item' }, ...children)

function allowance(value: Overview['chains'][number]['allowance']): string {
  if (value === null) {
    return 'Could not be read'
  }
  if (value.status === 'none') {
    return 'No onchain limit (killed)'
  }
  return `${formatUsd(value.spent)} of ${formatUsd(value.cap)} spent, resets ${when(value.resetsAt)}`
}

export function agentBadges(agent: { paused: boolean; mode: 'live' | 'shadow' }) {
  return [
    agent.mode === 'shadow' && el('span', { class: 'badge shadow' }, 'shadow'),
    agent.paused && el('span', { class: 'badge stop' }, 'paused'),
  ]
}

export async function overview(ctx: Context): Screen {
  const data = await ctx.api.overview()
  const waiting = data.pending.length + data.mandates.length
  return [
    el('h1', {}, 'Overview'),
    el('a', { href: href({ name: 'kill' }), class: 'kill' }, 'Stop everything'),
    card(
      el('h2', {}, waiting === 0 ? 'Nothing waiting' : `Waiting for you (${waiting})`),
      ...data.pending.map(({ intent }) =>
        link(
          { name: 'approval', id: intent.id },
          el('strong', {}, amountText(intent)),
          el('span', {}, `${intent.agentId} on ${chainName(intent.chain)}`),
          el('span', { class: 'muted' }, intent.domain ?? intent.recipient),
        ),
      ),
      ...data.mandates.map(({ mandate }) =>
        link(
          { name: 'mandate', id: mandate.id },
          el('strong', {}, `Task budget ${formatUsd(mandate.budget)}`),
          el('span', {}, mandate.agentId),
          el('span', { class: 'muted' }, mandate.reason),
        ),
      ),
    ),
    card(
      el('h2', {}, 'Chains'),
      data.chains.length === 0 && el('p', {}, 'No chain is configured: every payment is refused.'),
      ...data.chains.map((chain) =>
        el(
          'div',
          { class: 'item' },
          el('strong', {}, chainName(chain.chain)),
          el('span', {}, allowance(chain.allowance)),
        ),
      ),
    ),
    card(
      el('h2', {}, 'Agents'),
      data.agents.length === 0 && el('p', {}, 'No agents yet.'),
      ...data.agents.map((agent) =>
        link(
          { name: 'agent', id: agent.agentId },
          el('strong', {}, agent.agentId, ...agentBadges(agent)),
        ),
      ),
    ),
  ]
}
