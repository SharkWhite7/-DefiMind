import type { KillView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import type { Context, Screen } from './context.js'
import { button, card, el } from './dom.js'

function onchain(tx: KillView['ownerTransactions'][number]) {
  const built = tx.payload !== null
  return card(
    el('h2', {}, chainName(tx.chain)),
    el('p', { class: built ? '' : 'flag' }, tx.description),
    tx.link !== undefined && el('a', { href: tx.link, class: 'button primary' }, 'Open in Phantom'),
    tx.pageLink !== undefined &&
      el('a', { href: tx.pageLink, class: 'button' }, 'Open on this computer'),
    built &&
      tx.link === undefined &&
      el(
        'details',
        {},
        el('summary', {}, 'Transaction to sign'),
        el('pre', {}, JSON.stringify(tx.payload, null, 2)),
      ),
  )
}

export async function kill(ctx: Context): Screen {
  const result = el('div')
  return [
    el('h1', {}, 'Stop everything'),
    el(
      'p',
      {},
      'Pauses every agent at once: guard-core signs no more payments. Then remove the onchain limit on each chain with your wallet.',
    ),
    button(
      'Stop everything',
      async () => {
        const done = await ctx.api.kill()
        const agents = done.pausedAgents === 1 ? 'agent' : 'agents'
        ctx.say(`Stopped. ${done.pausedAgents} ${agents} paused.`, 'done')
        result.replaceChildren(...done.ownerTransactions.map(onchain))
      },
      'kill',
    ),
    result,
  ]
}
