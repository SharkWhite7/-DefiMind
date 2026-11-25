import { TRADER_TEMPLATES, type TraderTemplate } from '@defimind/shared'
import type { PolicyView, TraderView } from '../adapters/schemas.js'
import { formatUsd } from '../domain/money.js'
import { loosens } from '../domain/policy.js'
import {
  CADENCES,
  defaultConfig,
  fromTraderForm,
  MODELS,
  type TraderConfig,
  traderLoosens,
} from '../domain/trader.js'
import { NO_TRADING } from '../domain/trading.js'
import type { Context } from './context.js'
import { button, card, el } from './dom.js'
import { tokenIcon } from './risk.js'

function select(id: string, options: readonly (readonly [string, string])[], value: string) {
  const node = el('select', { id })
  node.append(...options.map(([v, label]) => el('option', { value: v }, label)))
  node.value = value
  return node
}

const labelled = (id: string, label: string, node: HTMLElement) => [
  el('label', { for: id }, label),
  node,
]

/** Its suggested limits go through the policy, with the passkey when they loosen it. */
function suggestedLimits(ctx: Context, policy: PolicyView, template: TraderTemplate) {
  const s = template.suggested
  const trading = policy.trading ?? NO_TRADING
  const after: PolicyView = {
    ...policy,
    trading: {
      ...trading,
      maxTradeUsd: s.maxTradeUsd,
      dailyTradeMax: s.dailyTradeMax,
      maxPositionUsd: s.maxPositionUsd,
    },
  }
  return [
    el(
      'p',
      { class: 'muted' },
      `Suggested limits: ${formatUsd(s.maxTradeUsd)} per buy, ${formatUsd(s.dailyTradeMax)} a day, ${formatUsd(s.maxPositionUsd)} held in one token${s.orders ? ', and take-profit and stop-loss orders on (in Trading limits)' : ''}.`,
    ),
    button('Apply suggested limits', async () => {
      const loose = loosens(policy, after)
      await ctx.api.putPolicy(after, loose)
      await ctx.go({ name: 'trader', id: policy.agentId }, true)
      ctx.say(loose ? 'Limits applied. Confirmed with your passkey.' : 'Limits applied.', 'done')
    }),
  ]
}

/** CR-027 setup: a ready-made strategy or the owner's own words, the model, the pace and the tokens. */
export function setup(ctx: Context, status: TraderView | undefined, policy: PolicyView) {
  const before = status?.config
  const config: TraderConfig = before ?? defaultConfig()
  const strategy = select(
    'strategy',
    [['', 'Write my own'], ...TRADER_TEMPLATES.map((t) => [t.id, t.name] as const)],
    config.template?.id ?? '',
  )
  const about = el('div')
  const instructions = el('textarea', { id: 'instructions', rows: '6', maxlength: '2000' })
  instructions.value = config.instructions
  const model = select('model', MODELS, config.model)
  const effort = select(
    'effort',
    [
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ],
    config.effort,
  )
  const cadence = select(
    'cadence',
    CADENCES.map((m) => [String(m), `Every ${m} minutes`] as const),
    String(config.cadenceMinutes),
  )
  const actions = el('input', { id: 'actions', inputmode: 'numeric', autocomplete: 'off' })
  actions.value = String(config.maxActionsPerTick)
  const mode = select(
    'mode',
    [
      ['shadow', 'Shadow: decides, trades nothing'],
      ['live', 'Live: trades for real'],
    ],
    config.mode,
  )
  const enabled = el('input', { id: 'trader-on', type: 'checkbox' })
  enabled.checked = config.enabled
  const allowed = [...new Set([...(policy.trading?.tokens ?? []), ...config.tokens])]
  const boxes = allowed.map((mint, i) => {
    const box = el('input', { id: `tt-${i}`, type: 'checkbox' })
    box.checked = config.tokens.includes(mint)
    return { mint, box }
  })
  const pick = () => {
    const template = TRADER_TEMPLATES.find((t) => t.id === strategy.value)
    if (template === undefined) {
      about.replaceChildren()
      return
    }
    instructions.value = template.instructions
    cadence.value = String(template.suggested.cadenceMinutes)
    actions.value = String(template.suggested.maxActionsPerTick)
    about.replaceChildren(
      el('p', {}, template.summary),
      el(
        'p',
        { class: 'muted' },
        'Ready-made, not tested: no strategy can promise a result. Edit anything before you save.',
      ),
      ...suggestedLimits(ctx, policy, template),
    )
  }
  strategy.addEventListener('change', pick)
  return card(
    el('h2', {}, 'Setup'),
    status?.keySet === false &&
      el(
        'p',
        { class: 'flag' },
        'The Anthropic API key is not set. Add ANTHROPIC_API_KEY on the server; the trader cannot run without it.',
      ),
    ...labelled('strategy', 'Strategy', strategy),
    about,
    ...labelled('instructions', 'Instructions, in plain words', instructions),
    el(
      'p',
      { class: 'muted' },
      "Up to 2000 characters. The trader follows them inside this agent's rules; nothing it writes can change the rules.",
    ),
    el('p', {}, 'Tokens it may trade'),
    allowed.length === 0 &&
      el('p', { class: 'muted' }, 'Allow tokens for this agent first, on its page.'),
    ...boxes.map(({ mint, box }) =>
      el(
        'label',
        { class: 'check token' },
        box,
        tokenIcon(mint),
        el('span', { class: 'mono' }, mint),
      ),
    ),
    ...labelled('model', 'Model', model),
    ...labelled('effort', 'How hard it thinks', effort),
    ...labelled('cadence', 'How often it checks', cadence),
    ...labelled('actions', 'Most trades per check, 1 to 5', actions),
    ...labelled('mode', 'Mode', mode),
    el('label', { class: 'check' }, enabled, 'Turn the trader on'),
    el(
      'p',
      { class: 'muted' },
      'Turning it on, going live or changing what it does asks for your passkey. Turning it off does not.',
    ),
    button(
      'Save trader',
      async () => {
        const form = fromTraderForm(config, {
          instructions: instructions.value,
          tokens: boxes
            .filter(({ box }) => box.checked)
            .map(({ mint }) => mint)
            .join('\n'),
          maxActionsPerTick: actions.value,
        })
        if (typeof form === 'string') {
          ctx.say(form, 'stop')
          return
        }
        const template = TRADER_TEMPLATES.find((t) => t.id === strategy.value)
        const minutes = Number(cadence.value) as TraderConfig['cadenceMinutes']
        const after: TraderConfig = {
          ...form,
          enabled: enabled.checked,
          mode: mode.value === 'live' ? 'live' : 'shadow',
          model: model.value,
          effort: effort.value as TraderConfig['effort'],
          cadenceMinutes: minutes,
          maxTicksPerDay:
            before === undefined || minutes !== config.cadenceMinutes
              ? (24 * 60) / minutes
              : config.maxTicksPerDay,
          template:
            template === undefined ? undefined : { id: template.id, version: template.version },
        }
        if (after.template === undefined) {
          delete after.template
        }
        const loose = traderLoosens(before, after)
        await ctx.api.putTrader(policy.agentId, after, loose)
        await ctx.go({ name: 'trader', id: policy.agentId }, true)
        ctx.say(loose ? 'Trader saved. Confirmed with your passkey.' : 'Trader saved.', 'done')
      },
      'primary',
    ),
  )
}
