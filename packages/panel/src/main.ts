import { ApiError, Cancelled, ownerApi } from './adapters/api.js'
import { browserAuthenticator } from './adapters/webauthn.js'
import { BASE, href, parseRoute, type Route } from './domain/route.js'
import { agent } from './ui/agent.js'
import { agents } from './ui/agents.js'
import { approval, mandate } from './ui/approval.js'
import type { Context, Screen } from './ui/context.js'
import { el } from './ui/dom.js'
import { kill } from './ui/kill.js'
import { enrol, login } from './ui/login.js'
import { overview } from './ui/overview.js'
import { doctor, report } from './ui/report.js'
import { settings } from './ui/settings.js'

const view = document.getElementById('app')!
const status = document.getElementById('status')!

/** Where to go once signed in: the screen a notification or a link opened. */
let after: Route = { name: 'overview' }

const ERRORS: Record<string, string> = {
  step_up_required: 'This needs your passkey. Try again.',
  bad_origin: 'Open the panel from its own address, not through another site.',
  already_decided: 'Already decided.',
  expired: 'It expired before the decision.',
  exists: 'An agent with that name exists.',
  not_found: 'Not found.',
}

const ctx: Context = {
  api: ownerApi(browserAuthenticator),
  go(route, replace = false) {
    history[replace ? 'replaceState' : 'pushState'](null, '', href(route))
    return render()
  },
  say(message, tone = 'info') {
    status.textContent = message
    status.dataset['tone'] = tone
  },
}

function fail(error: unknown) {
  if (error instanceof ApiError && error.noSession) {
    void ctx.go({ name: 'login' }, true)
  } else if (error instanceof Cancelled) {
    ctx.say('Passkey cancelled: nothing was sent.')
  } else if (error instanceof ApiError) {
    ctx.say(ERRORS[error.code] ?? `guard-core refused it (${error.code}).`, 'stop')
  } else {
    ctx.say(error instanceof Error ? error.message : 'Something went wrong.', 'stop')
  }
}

function screen(route: Route): Screen {
  switch (route.name) {
    case 'login':
      return login(ctx, async () => {
        await ctx.go(after, true)
        ctx.say('')
      })
    case 'enrol':
      return enrol(ctx, route.code)
    case 'overview':
      return overview(ctx)
    case 'approval':
      return approval(ctx, route.id)
    case 'mandate':
      return mandate(ctx, route.id)
    case 'agents':
      return agents(ctx)
    case 'agent':
      return agent(ctx, route.id)
    case 'report':
      return report(ctx)
    case 'doctor':
      return doctor(ctx)
    case 'settings':
    case 'passkeys':
      return settings(ctx)
    case 'kill':
      return kill(ctx)
    case 'missing':
      return Promise.resolve([el('h1', {}, 'Nothing here'), el('a', { href: BASE }, 'Overview')])
  }
}

async function render() {
  const route = parseRoute(location.pathname, location.hash)
  if (route.name !== 'login' && route.name !== 'enrol') {
    after = route
  }
  document.body.dataset['screen'] = route.name
  view.setAttribute('aria-busy', 'true')
  try {
    view.replaceChildren(
      ...(await screen(route)).filter(
        (child) => typeof child === 'string' || child instanceof Node,
      ),
    )
    window.scrollTo(0, 0)
  } catch (error) {
    fail(error)
  } finally {
    view.removeAttribute('aria-busy')
  }
}

/** Buttons run their action outside render: their errors land here. */
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault()
  fail(event.reason)
})

document.addEventListener('click', (event) => {
  const anchor = event.target instanceof Element ? event.target.closest('a') : null
  if (anchor && anchor.origin === location.origin && anchor.pathname.startsWith(BASE)) {
    event.preventDefault()
    status.textContent = ''
    history.pushState(null, '', anchor.pathname + anchor.hash)
    void render()
  }
})
window.addEventListener('popstate', () => void render())

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE })
}
void render()
