import { describe, expect, it } from 'vitest'
import { ApiError, Cancelled, ownerApi } from '../src/adapters/api.js'
import {
  type Assertion,
  type Authenticator,
  decodeCreation,
  decodeRequest,
  fromBase64url,
  toBase64url,
} from '../src/adapters/webauthn.js'

const assertion: Assertion = {
  id: 'cred',
  rawId: 'cred',
  type: 'public-key',
  authenticatorAttachment: undefined,
  clientExtensionResults: {},
  response: { clientDataJSON: 'a', authenticatorData: 'b', signature: 'c' },
}
const options = { challenge: 'AAEC' }

interface Call {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

/** guard-core as a list of answers, one per call, recording what the panel sent. */
function server(answers: [number, unknown][], passkey: Partial<Authenticator> = {}) {
  const calls: Call[] = []
  const fetchImpl = async (path: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      method: init.method ?? 'GET',
      path: String(path),
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    expect(init.credentials).toBe('same-origin')
    const [status, body] = answers.shift() ?? [500, {}]
    return new Response(JSON.stringify(body), { status })
  }
  const authenticator: Authenticator = {
    assert: async () => assertion,
    register: async () => null,
    ...passkey,
  }
  return { api: ownerApi(authenticator, fetchImpl as typeof fetch), calls }
}

describe('base64url', () => {
  it('round-trips bytes without padding', () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 250])
    const text = toBase64url(bytes.buffer)
    expect(text).toBe('AP8-P_o')
    expect(new Uint8Array(fromBase64url(text))).toEqual(bytes)
  })

  it('decodes the options guard-core sends', () => {
    const request = decodeRequest({
      challenge: 'AAEC',
      allowCredentials: [{ id: 'AP8', type: 'public-key', transports: ['internal'] }],
    })
    expect(new Uint8Array(request.challenge as ArrayBuffer)).toEqual(new Uint8Array([0, 1, 2]))
    expect(request.userVerification).toBe('required')
    expect(request.allowCredentials?.[0]?.transports).toEqual(['internal'])
    const creation = decodeCreation({
      challenge: 'AAEC',
      rp: { name: 'DefiMind' },
      user: { id: 'AQ', name: 'owner', displayName: 'Owner' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    })
    expect(new Uint8Array(creation.user.id as ArrayBuffer)).toEqual(new Uint8Array([1]))
    expect(creation.attestation).toBe('none')
  })
})

describe('owner api', () => {
  it('reads without the request header and writes with it', async () => {
    const { api, calls } = server([
      [200, { checks: [] }],
      [200, { agentId: 'bot', revoked: true }],
    ])
    await api.doctor()
    await api.revokeAgent('a/b')
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v1/owner/doctor', headers: {} })
    expect(calls[1]).toMatchObject({
      method: 'POST',
      path: '/v1/owner/agents/a%2Fb/revoke',
      headers: { 'x-defimind-request': '1', 'content-type': 'application/json' },
      body: {},
    })
  })

  it('binds the step-up to the action and body, then sends the assertion', async () => {
    const { api, calls } = server([
      [200, options],
      [200, {}],
    ])
    await api.approveIntent('i-1')
    expect(calls.map((call) => call.body)).toEqual([
      { action: 'approve_intent', body: { intentId: 'i-1' } },
      { decision: 'approve', assertion },
    ])
    expect(calls[1]?.path).toBe('/v1/owner/intents/i-1/decision')
  })

  it('rejects without a passkey', async () => {
    const { api, calls } = server([[200, {}]])
    await api.rejectMandate('m-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toEqual({ decision: 'reject' })
  })

  it('asks for the passkey only when the policy loosens', async () => {
    const policy = {
      agentId: 'bot',
      chains: [],
      tokens: [],
      perTxMax: '1',
      dailyMax: '1',
      approvalThreshold: '1',
      allowedRecipients: [],
      allowedDomains: [],
      paused: false,
    }
    const tight = server([[200, policy]])
    await tight.api.putPolicy(policy, false)
    expect(tight.calls[0]).toMatchObject({ method: 'PUT', body: { policy } })

    const loose = server([
      [200, options],
      [200, policy],
    ])
    await loose.api.putPolicy(policy, true)
    expect(loose.calls.map((call) => call.body)).toEqual([
      { action: 'loosen_policy', body: { agentId: 'bot', policy } },
      { policy, assertion },
    ])
  })

  it('sends nothing when the owner cancels the passkey', async () => {
    const { api, calls } = server(
      [
        [200, options],
        [200, options],
      ],
      { assert: async () => null },
    )
    await expect(api.resume('bot')).rejects.toBeInstanceOf(Cancelled)
    await expect(api.login()).rejects.toBeInstanceOf(Cancelled)
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/owner/challenge',
      '/v1/owner/session/options',
    ])
  })

  it('logs in and enrols with the options guard-core gave', async () => {
    const registration = { id: 'r' }
    const { api, calls } = server(
      [
        [200, options],
        [200, { expiresAt: '2026-11-18T12:00:00.000Z' }],
        [
          200,
          {
            ...options,
            rp: { name: 'D' },
            user: { id: 'AQ', name: 'o', displayName: 'O' },
            pubKeyCredParams: [],
          },
        ],
        [200, { ok: true }],
      ],
      { register: async () => registration as never },
    )
    await expect(api.login()).resolves.toEqual({ expiresAt: '2026-11-18T12:00:00.000Z' })
    await api.enrol('code-1')
    expect(calls.map((call) => call.body)).toEqual([
      {},
      { assertion },
      { code: 'code-1' },
      { code: 'code-1', response: registration },
    ])
  })

  it('turns an error answer into its status and code', async () => {
    const { api } = server([
      [401, { error: 'no_session' }],
      [403, 'not json at all'],
    ])
    const first = await api.overview().catch((error: unknown) => error)
    expect(first).toBeInstanceOf(ApiError)
    expect(first).toMatchObject({ status: 401, code: 'no_session', noSession: true })
    await expect(api.kill()).rejects.toMatchObject({ status: 403, code: 'error', noSession: false })
  })

  it('refuses an answer that does not match the schema', async () => {
    const { api } = server([[200, { passkeys: 'none' }]])
    await expect(api.passkeys()).rejects.toThrow()
  })

  it('subscribes and unsubscribes push', async () => {
    const { api, calls } = server([
      [200, { publicKey: 'BEl6' }],
      [200, { id: 'p 1' }],
      [200, { ok: true }],
    ])
    await api.pushKey()
    const subscription = { endpoint: 'https://push.example/x', keys: { p256dh: 'k', auth: 'a' } }
    await expect(api.subscribe(subscription)).resolves.toEqual({ id: 'p 1' })
    await api.unsubscribe('p 1')
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /v1/owner/push/key',
      'POST /v1/owner/push',
      'DELETE /v1/owner/push/p%201',
    ])
    expect(calls[1]?.body).toEqual({ subscription })
  })

  it('asks the report for the window it shows', async () => {
    const { api, calls } = server([[200, { agents: [] }]])
    await api.report(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-08T00:00:00Z'))
    expect(calls[0]?.path).toBe(
      '/v1/owner/report?from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-08T00%3A00%3A00.000Z',
    )
  })
})
