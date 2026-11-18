import type { Context, Screen } from './context.js'
import { button, el } from './dom.js'

export async function login(ctx: Context, next: () => Promise<void>): Screen {
  return [
    el('h1', {}, 'DefiMind'),
    el('p', {}, 'Sign in with the passkey on this device.'),
    button(
      'Sign in with passkey',
      async () => {
        await ctx.api.login()
        await next()
      },
      'primary',
    ),
  ]
}

export async function enrol(ctx: Context, code: string): Screen {
  return [
    el('h1', {}, 'Add your passkey'),
    el(
      'p',
      {},
      'This makes a passkey on this device for DefiMind. It approves payments from now on, so use a device only you unlock.',
    ),
    el('p', { class: 'muted' }, 'The link works once and for 10 minutes.'),
    button(
      'Create passkey',
      async () => {
        await ctx.api.enrol(code)
        // The code is spent: replace the entry so it leaves the history.
        await ctx.go({ name: 'login' }, true)
        ctx.say('Passkey saved. Sign in with it.', 'done')
      },
      'primary',
    ),
  ]
}
