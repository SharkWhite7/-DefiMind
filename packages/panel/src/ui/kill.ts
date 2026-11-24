import type { KillView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { isSolana } from '../domain/guide.js'
import { units } from '../domain/trading.js'
import type { Context, Screen } from './context.js'
import { button, card, el } from './dom.js'

/**
 * Without a link, a deployment whose hot wallet the hosted signing page does not know (a one-click
 * one), the owner removes the limit in the vault's own app. The agents are already paused; this only
 * takes away what the hot wallet could still draw.
 */
function byHand(chain: string) {
  const [app, where] = isSolana(chain)
    ? [
        'https://app.squads.so',
        'open your vault, then Settings, then Spending limits, and remove the limit',
      ]
    : [
        'https://app.safe.global',
        'open your Safe, then Settings, then Spending limits, and delete the limit',
      ]
  return [
    el(
      'p',
      {},
      `Your agents are paused. To be sure the vault pays nothing more, connect your wallet there, ${where}.`,
    ),
    el('a', { href: app, class: 'button primary', rel: 'noreferrer' }, `Open ${new URL(app).host}`),
  ]
}

function onchain(tx: KillView['ownerTransactions'][number]) {
  const built = tx.payload !== null
  const linked = tx.link !== undefined || tx.pageLink !== undefined
  return card(
    el('h2', {}, chainName(tx.chain)),
    el('p', { class: built ? '' : 'flag' }, tx.description),
    tx.link !== undefined && el('a', { href: tx.link, class: 'button primary' }, 'Open in Phantom'),
    tx.pageLink !== undefined &&
      el('a', { href: tx.pageLink, class: 'button' }, 'Open on this computer'),
    ...(linked ? [] : byHand(tx.chain)),
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

/**
 * Whether any agent holds a token. The Stop screen must open on any guard-core, one without
 * trading included, so a failed read counts as none.
 */
const holding = (ctx: Context) =>
  ctx.api
    .portfolio()
    .then(({ agents }) => agents.some((agent) => agent.positions.length > 0))
    .catch(() => false)

/** CR-021: sells every token back to the chain's dollar, through the same checks as any swap. */
function closePositions(ctx: Context) {
  const result = el('div')
  return card(
    el('h2', {}, 'Close positions'),
    el(
      'p',
      {},
      "Sells every token your agents hold back to the chain's dollar, through the same checks as any trade. Works while agents are paused.",
    ),
    button(
      'Close positions with passkey',
      async () => {
        const { intents } = await ctx.api.closePositions()
        const tokens = intents.length === 1 ? 'token' : 'tokens'
        ctx.say(`Selling ${intents.length} ${tokens}.`, 'done')
        result.replaceChildren(
          ...intents.map((intent) =>
            el(
              'div',
              { class: 'item' },
              el('strong', { class: 'mono' }, units(intent.amount, intent.token)),
              el('span', {}, `${chainName(intent.chain)}: ${intent.status}`),
            ),
          ),
        )
      },
      'danger',
    ),
    result,
  )
}

export async function kill(ctx: Context): Screen {
  const result = el('div')
  const held = await holding(ctx)
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
    held && closePositions(ctx),
  ]
}
