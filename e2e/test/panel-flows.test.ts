import type { Receipt } from '@defimind/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { softAuthenticator } from '../../packages/guard-core/test/webauthn.js'
import { offer, paidApi, type PaidApi } from './support/paid-api.js'
import { intentIdIn, PANEL_RP, stack, type Stack } from './support/stack.js'

// CR-012: with the default TELEGRAM_APPROVALS=false, a payment over the threshold is approved
// only in the owner panel, with a passkey; a Telegram tap can still reject but never approve.

let s: Stack
let api: PaidApi

beforeEach(async () => {
  s = await stack({ panel: true })
  api = await paidApi()
  await s.setPolicy()
})

afterEach(async () => {
  await api.close()
  await s.close()
})

const PANEL = { origin: PANEL_RP.origin, 'x-defimind-request': '1' }

/** The owner's first passkey, then a panel session opened with it. */
async function owner() {
  const device = softAuthenticator(PANEL_RP.id, PANEL_RP.origin)
  const enrol = await s.admin('POST', '/v1/admin/passkeys/options')
  const { challenge } = enrol.body as { challenge: string }
  await s.admin('POST', '/v1/admin/passkeys', { response: device.register(challenge) })

  let cookie = ''
  const call = async (url: string, payload: object = {}) => {
    const res = await s.guard.inject({
      method: 'POST',
      url,
      headers: { ...PANEL, cookie },
      payload,
    })
    return { status: res.statusCode, body: res.json<Record<string, unknown>>(), res }
  }
  const options = await call('/v1/owner/session/options')
  const signIn = await call('/v1/owner/session', {
    assertion: device.assert(String(options.body['challenge'])),
  })
  cookie = /dm_session=[^;]*/.exec(String(signIn.res.headers['set-cookie']))?.[0] ?? ''
  expect(cookie).not.toBe('')

  return {
    call,
    async approve(intentId: string) {
      const body = { intentId }
      const step = await call('/v1/owner/challenge', { action: 'approve_intent', body })
      const assertion = device.assert(String(step.body['challenge']))
      return call(`/v1/owner/intents/${intentId}/decision`, { decision: 'approve', assertion })
    },
  }
}

describe('owner panel approvals', () => {
  it('refuses an approval from Telegram, then pays once the owner approves in the panel', async () => {
    api.quote = [offer({ amount: '3000000' })]
    const id = intentIdIn(await s.tool('paid_fetch', { url: api.url }))
    await vi.waitFor(() => expect(s.telegram.approvalFor(id)).toBeDefined())

    await s.telegram.press(id, 'approve')
    expect(s.telegram.lastAnswer()).not.toBe('Approved')
    expect((await s.intent(id)).status).toBe('pending_approval')

    const panel = await owner()
    const decided = await panel.approve(id)
    expect(decided.status).toBe(200)

    const second = await s.tool('paid_fetch', { url: api.url })
    expect(second).toContain(': executed.')
    expect(api.payments).toHaveLength(1)

    const receipt = await fetch(new URL(`/v1/agent/intents/${id}/receipt`, s.guardUrl), {
      headers: { authorization: `Bearer ${s.agentToken}` },
    })
    expect(((await receipt.json()) as Receipt).approvedBy).toBe('passkey')
  })

  it('needs the passkey: an approval without one moves nothing', async () => {
    api.quote = [offer({ amount: '3000000' })]
    const id = intentIdIn(await s.tool('paid_fetch', { url: api.url }))
    await vi.waitFor(() => expect(s.telegram.approvalFor(id)).toBeDefined())

    const panel = await owner()
    const bare = await panel.call(`/v1/owner/intents/${id}/decision`, { decision: 'approve' })
    expect(bare.status).toBe(403)
    expect(bare.body['error']).toBe('step_up_required')
    expect((await s.intent(id)).status).toBe('pending_approval')
    expect(api.payments).toHaveLength(0)
  })

  it('still lets Telegram reject', async () => {
    api.quote = [offer({ amount: '3000000' })]
    const id = intentIdIn(await s.tool('paid_fetch', { url: api.url }))
    await vi.waitFor(() => expect(s.telegram.approvalFor(id)).toBeDefined())

    await s.telegram.press(id, 'reject')
    expect(s.telegram.lastAnswer()).toBe('Rejected')
    expect((await s.intent(id)).status).toBe('rejected')
    expect(api.payments).toHaveLength(0)
  })
})
