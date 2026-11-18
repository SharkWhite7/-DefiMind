import type { z } from 'zod'
import * as s from './schemas.js'
import {
  type Assertion,
  type Authenticator,
  creationOptions,
  type Registration,
  requestOptions,
} from './webauthn.js'

/** The step-up actions of SPEC: each assertion is bound to one action and its exact body. */
export type OwnerAction =
  'approve_intent' | 'approve_mandate' | 'loosen_policy' | 'resume' | 'create_agent'

/** An answer guard-core gave as an error: its status and the code in its body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`)
  }

  get noSession(): boolean {
    return this.status === 401
  }
}

/** The owner closed the passkey prompt: nothing was sent. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

const json = { 'content-type': 'application/json' }

/**
 * Every call guard-core's owner routes take. Same origin, with the session cookie; every
 * state-changing one carries X-DefiMind-Request, which a cross-site form cannot send.
 */
export function ownerApi(passkey: Authenticator, fetchImpl: typeof fetch = fetch.bind(globalThis)) {
  async function call<T>(schema: z.ZodType<T>, method: string, path: string, body?: unknown) {
    const response = await fetchImpl(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(method === 'GET' ? {} : { 'x-defimind-request': '1' }),
        ...(body === undefined ? {} : json),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const code = s.problem.safeParse(data)
      throw new ApiError(response.status, code.success ? code.data.error : 'error')
    }
    return schema.parse(data)
  }

  const get = <T>(schema: z.ZodType<T>, path: string) => call(schema, 'GET', path)
  const post = <T>(schema: z.ZodType<T>, path: string, body: unknown = {}) =>
    call(schema, 'POST', path, body)
  const agent = (id: string) => encodeURIComponent(id)
  const ignored = s.problem.partial().passthrough()

  /** A fresh passkey assertion for this exact action and body, then the call that carries it. */
  async function stepUp<T>(
    action: OwnerAction,
    body: Record<string, unknown>,
    send: (assertion: Assertion) => Promise<T>,
  ) {
    const options = await post(requestOptions, '/v1/owner/challenge', { action, body })
    const assertion = await passkey.assert(options)
    if (assertion === null) {
      throw new Cancelled()
    }
    return send(assertion)
  }

  return {
    async login() {
      const options = await post(requestOptions, '/v1/owner/session/options')
      const assertion = await passkey.assert(options)
      if (assertion === null) {
        throw new Cancelled()
      }
      return post(s.session, '/v1/owner/session', { assertion })
    },
    logout: () => post(ignored, '/v1/owner/session/logout'),

    async enrol(code: string) {
      const options = await post(creationOptions, '/v1/owner/passkeys/options', { code })
      const response: Registration | null = await passkey.register(options)
      if (response === null) {
        throw new Cancelled()
      }
      return post(ignored, '/v1/owner/passkeys', { code, response })
    },

    overview: () => get(s.overview, '/v1/owner/overview'),

    rejectIntent: (id: string) =>
      post(ignored, `/v1/owner/intents/${id}/decision`, { decision: 'reject' }),
    approveIntent: (id: string) =>
      stepUp('approve_intent', { intentId: id }, (assertion) =>
        post(ignored, `/v1/owner/intents/${id}/decision`, { decision: 'approve', assertion }),
      ),
    rejectMandate: (id: string) =>
      post(ignored, `/v1/owner/mandates/${id}/decision`, { decision: 'reject' }),
    approveMandate: (id: string) =>
      stepUp('approve_mandate', { mandateId: id }, (assertion) =>
        post(ignored, `/v1/owner/mandates/${id}/decision`, { decision: 'approve', assertion }),
      ),

    agents: () => get(s.agents, '/v1/owner/agents'),
    createAgent: (agentId: string) =>
      stepUp('create_agent', { agentId }, (assertion) =>
        post(s.created, '/v1/owner/agents', { agentId, assertion }),
      ),
    revokeAgent: (id: string) => post(ignored, `/v1/owner/agents/${agent(id)}/revoke`),
    pause: (agentId: string) => post(ignored, '/v1/owner/pause', { agentId }),
    resume: (agentId: string) =>
      stepUp('resume', { agentId }, (assertion) =>
        post(ignored, '/v1/owner/resume', { agentId, assertion }),
      ),

    policy: (id: string) => get(s.policy, `/v1/owner/policy/${agent(id)}`),
    /** loose: the change loosens the policy, so it goes with a passkey assertion. */
    putPolicy: (policy: s.PolicyView, loose: boolean) => {
      const path = `/v1/owner/policy/${agent(policy.agentId)}`
      return loose
        ? stepUp('loosen_policy', { agentId: policy.agentId, policy }, (assertion) =>
            call(s.policy, 'PUT', path, { policy, assertion }),
          )
        : call(s.policy, 'PUT', path, { policy })
    },
    budget: (id: string) => get(s.budget, `/v1/owner/budget/${agent(id)}`),

    report: (from: Date, to: Date) =>
      get(
        s.report,
        `/v1/owner/report?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`,
      ),
    doctor: () => get(s.doctor, '/v1/owner/doctor'),
    passkeys: () => get(s.passkeys, '/v1/owner/passkeys'),
    kill: () => post(s.kill, '/v1/owner/kill'),

    pushKey: () => get(s.pushKey, '/v1/owner/push/key'),
    subscribe: (subscription: PushSubscriptionJSON) =>
      post(s.pushId, '/v1/owner/push', { subscription }),
    unsubscribe: (id: string) =>
      call(ignored, 'DELETE', `/v1/owner/push/${encodeURIComponent(id)}`),
  }
}

export type OwnerApi = ReturnType<typeof ownerApi>
