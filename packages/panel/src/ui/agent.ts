import type { BudgetView, PolicyView } from '../adapters/schemas.js'
import { chainName } from '../domain/chains.js'
import { fromForm, toForm } from '../domain/form.js'
import { formatUsd } from '../domain/money.js'
import { loosens } from '../domain/policy.js'
import type { Context, Screen } from './context.js'
import { button, card, el, row, when } from './dom.js'

function field(id: string, label: string, value: string, multiline = false) {
  const input = multiline
    ? el('textarea', { id, rows: '3', spellcheck: 'false' })
    : el('input', { id, inputmode: 'decimal', autocomplete: 'off' })
  input.value = value
  return { input, nodes: [el('label', { for: id }, label), input] }
}

function shadowLine(budget: BudgetView): string {
  if (budget.shadow) {
    return `Would have spent ${formatUsd(budget.shadow.total)} in ${budget.shadow.count} payments since ${when(budget.shadow.since)}.`
  }
  return `Would have spent ${formatUsd(budget.shadowSpentToday ?? '0')} today.`
}

/** Saves a policy, with a passkey first when SPEC says the change loosens it. */
async function save(ctx: Context, before: PolicyView, after: PolicyView, message: string) {
  const loose = loosens(before, after)
  await ctx.api.putPolicy(after, loose)
  await ctx.go({ name: 'agent', id: before.agentId }, true)
  ctx.say(loose ? `${message} Confirmed with your passkey.` : message, 'done')
}

function policyForm(ctx: Context, policy: PolicyView) {
  const form = toForm(policy)
  const perTx = field('per-tx', 'Per payment, in dollars', form.perTxMax)
  const daily = field('daily', 'Per day, in dollars', form.dailyMax)
  const ask = field('threshold', 'Ask me from, in dollars', form.approvalThreshold)
  const domains = field(
    'domains',
    'Paid APIs it may use (one host per line)',
    form.allowedDomains,
    true,
  )
  const recipients = field(
    'recipients',
    'Addresses it may pay (one per line)',
    form.allowedRecipients,
    true,
  )
  const mandate = el('input', { id: 'mandate', type: 'checkbox' })
  mandate.checked = form.requireMandate
  return card(
    el('h2', {}, 'Policy'),
    el(
      'dl',
      {},
      row('Chains', policy.chains.map(chainName).join(', ') || 'none'),
      row('Tokens', policy.tokens.join(', ') || 'none'),
    ),
    ...perTx.nodes,
    ...daily.nodes,
    ...ask.nodes,
    ...domains.nodes,
    ...recipients.nodes,
    el('label', { class: 'check' }, mandate, 'Only pay inside a task budget I approved'),
    el('p', { class: 'muted' }, 'Raising a limit or adding to a list asks for your passkey.'),
    button(
      'Save policy',
      async () => {
        const after = fromForm(policy, {
          perTxMax: perTx.input.value,
          dailyMax: daily.input.value,
          approvalThreshold: ask.input.value,
          allowedDomains: domains.input.value,
          allowedRecipients: recipients.input.value,
          requireMandate: mandate.checked,
        })
        if (typeof after === 'string') {
          ctx.say(after, 'stop')
          return
        }
        await save(ctx, policy, after, 'Policy saved.')
      },
      'primary',
    ),
  )
}

export async function agent(ctx: Context, id: string): Screen {
  const [policy, budget] = await Promise.all([ctx.api.policy(id), ctx.api.budget(id)])
  const shadow = policy.mode === 'shadow'
  return [
    el('h1', {}, id),
    card(
      el('h2', {}, shadow ? 'Shadow mode' : 'Live'),
      el(
        'p',
        {},
        shadow
          ? 'Every payment is checked and simulated, and none is signed.'
          : 'Payments inside the policy are signed and sent.',
      ),
      shadow && el('p', { class: 'shadow-total' }, shadowLine(budget)),
      button(
        shadow ? 'Go live with passkey' : 'Switch to shadow',
        async () =>
          save(
            ctx,
            policy,
            { ...policy, mode: shadow ? 'live' : 'shadow' },
            shadow ? 'Live.' : 'In shadow mode.',
          ),
        shadow ? 'primary' : 'secondary',
      ),
    ),
    card(
      el('h2', {}, 'Today'),
      el(
        'dl',
        {},
        row('Spent', `${formatUsd(budget.spentToday)} of ${formatUsd(budget.dailyMax)}`),
        row('Per payment', formatUsd(budget.perTxMax)),
        row('State', budget.paused ? 'Paused' : 'Running'),
      ),
      budget.paused
        ? button(
            'Resume with passkey',
            async () => {
              await ctx.api.resume(id)
              await ctx.go({ name: 'agent', id }, true)
              ctx.say('Resumed.', 'done')
            },
            'primary',
          )
        : button('Pause', async () => {
            await ctx.api.pause(id)
            await ctx.go({ name: 'agent', id }, true)
            ctx.say('Paused: its payments are refused.', 'done')
          }),
    ),
    policyForm(ctx, policy),
    card(
      el('h2', {}, 'Revoke'),
      el('p', {}, 'Cuts the agent off at its next request. Its token never works again.'),
      button(
        'Revoke agent',
        async () => {
          if (confirm(`Revoke ${id}? This cannot be undone.`)) {
            await ctx.api.revokeAgent(id)
            await ctx.go({ name: 'agents' })
            ctx.say(`Revoked ${id}.`, 'done')
          }
        },
        'danger',
      ),
    ),
  ]
}
