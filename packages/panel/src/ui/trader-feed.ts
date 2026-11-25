import type { TickView } from '../adapters/schemas.js'
import { href } from '../domain/route.js'
import { count, OUTCOMES } from '../domain/trader.js'
import type { Context } from './context.js'
import { button, card, el, when } from './dom.js'

const TONE: Record<string, string> = {
  acted: 'ok',
  held: '',
  skipped: 'wait',
  error: 'stop',
  refused: 'stop',
}

function action({ tool, status, rejectReasons }: TickView['actions'][number]) {
  const refused = rejectReasons.length > 0 ? `, refused: ${rejectReasons.join(', ')}` : ''
  return el('li', {}, `${tool}${status === undefined ? '' : `: ${status}`}${refused}`)
}

/** One check: what it did, the model's own words labelled as such, and what it cost in tokens. */
function tick(item: TickView) {
  const used = item.usage.input + item.usage.output
  return el(
    'div',
    { class: 'item tick' },
    el(
      'strong',
      {},
      el(
        'span',
        { class: `pill ${TONE[item.outcome] ?? ''}` },
        OUTCOMES[item.outcome] ?? item.outcome,
      ),
      ` ${when(item.startedAt)}`,
    ),
    item.reason !== '' &&
      el('p', { class: 'said' }, el('span', { class: 'muted' }, 'The trader says: '), item.reason),
    item.actions.length > 0 && el('ul', { class: 'facts' }, ...item.actions.map(action)),
    item.detail !== undefined && el('p', { class: 'muted' }, item.detail),
    el('span', { class: 'muted' }, `${item.model} · ${count(used)} tokens`),
  )
}

/** CR-027: every check, newest first, 50 at a time; each trade's record is in Executions. */
export async function feed(ctx: Context, agentId: string) {
  const { ticks } = await ctx.api.ticks(agentId)
  const list = el('div', {}, ...ticks.map(tick))
  let last = ticks.at(-1)
  const more = button('Show older', async () => {
    if (last === undefined) {
      return
    }
    const next = (await ctx.api.ticks(agentId, last.startedAt)).ticks
    list.append(...next.map(tick))
    last = next.at(-1)
    more.hidden = next.length < 50
  })
  more.hidden = ticks.length < 50
  return card(
    el('h2', {}, 'Decisions'),
    ticks.length === 0 && el('p', { class: 'muted' }, 'No checks yet.'),
    list,
    more,
    el('a', { href: href({ name: 'executions' }) }, 'Every trade is recorded in Executions'),
  )
}
