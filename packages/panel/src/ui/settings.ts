import { disablePush, enablePush, pushEnabled } from '../adapters/push.js'
import type { Context, Screen } from './context.js'
import { button, card, el, when } from './dom.js'

function pushSwitch(ctx: Context, on: boolean) {
  const toggle = el('input', { id: 'push', type: 'checkbox', role: 'switch' })
  toggle.checked = on
  toggle.addEventListener('change', () => {
    const want = toggle.checked
    toggle.disabled = true
    void (want ? enablePush(ctx.api) : disablePush(ctx.api))
      .then(() => ctx.say(want ? 'Notifications on.' : 'Notifications off.', 'done'))
      .catch((error: unknown) => {
        toggle.checked = !want
        ctx.say(error instanceof Error ? error.message : 'Could not change notifications.', 'stop')
      })
      .finally(() => {
        toggle.disabled = false
      })
  })
  return el('label', { class: 'check' }, toggle, 'Notify this device of approvals and alerts')
}

export async function settings(ctx: Context): Screen {
  const [{ passkeys }, push] = await Promise.all([ctx.api.passkeys(), pushEnabled()])
  return [
    el('h1', {}, 'Settings'),
    card(el('h2', {}, 'Notifications'), pushSwitch(ctx, push)),
    card(
      el('h2', {}, 'Passkeys'),
      ...passkeys.map((key) =>
        el(
          'div',
          { class: 'item' },
          el('strong', {}, `…${key.id.slice(-8)}`),
          el('span', {}, `Added ${when(key.createdAt)}`),
          el(
            'span',
            { class: 'muted' },
            key.lastUsedAt ? `Last used ${when(key.lastUsedAt)}` : 'Never used',
          ),
        ),
      ),
      el('p', { class: 'muted' }, 'Removing a passkey is a command on the guard-core machine.'),
    ),
    button('Sign out', async () => {
      await ctx.api.logout()
      await ctx.go({ name: 'login' })
    }),
  ]
}
