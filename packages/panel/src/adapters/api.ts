import { z } from 'zod'
import type { TraderConfig } from '../domain/trader.js'
import type { NewOrder } from '../domain/orders.js'
import * as s from './schemas.js'
import { type Assertion, type Authenticator, creationOptions, requestOptions } from './webauthn.js'

/** The step-up actions of SPEC: each assertion is bound to one action and its exact body. */
export type OwnerAction =
  | 'approve_intent'
  | 'approve_mandate'
  | 'loosen_policy'
  | 'resume'
  | 'create_agent'
  | 'change_settings'
  | 'close_positions'
  | 'agent_wallet'
  | 'manual_trade'
  | 'trader_settings'
  | 'resume_trader'
  | 'place_order'
  | 'cancel_order'

/** A swap for one agent, as the owner set it up: amountIn in tokenIn's base units. */
export interface Order {
  agentId: string
  chain: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  maxSlippageBps?: number
}

/** An answer guard-core gave as an error: its status and the code in its body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reasons: string[] = [],
  ) {
    super(`${status} ${code}`)
  }

  /** Only no_session means signing in again: a 401 passkey_not_verified is a failed passkey. */
  get noSession(): boolean {
    return this.status === 401 && this.code === 'no_session'
  }
}

/** The owner closed the passkey prompt: nothing was sent. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

const json = { 'content-type': 'application/json' }
const enrolOptions = z.object({ registration: creationOptions, stepUp: requestOptions.optional() })

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
      throw code.success
        ? new ApiError(response.status, code.data.error, code.data.rejectReasons)
        : new ApiError(response.status, 'error')
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

    /** After the first passkey, an enrolled one must vouch for the new one (stepUp). */
    async enrol(code: string) {
      const { registration, stepUp } = await post(enrolOptions, '/v1/owner/passkeys/options', {
        code,
      })
      const assertion = stepUp ? await passkey.assert(stepUp) : undefined
      if (assertion === null) {
        throw new Cancelled()
      }
      const response = await passkey.register(registration)
      if (response === null) {
        throw new Cancelled()
      }
      return post(ignored, '/v1/owner/passkeys', {
        code,
        response,
        ...(assertion ? { assertion } : {}),
      })
    },

    overview: () => get(s.overview, '/v1/owner/overview'),

    setup: () => get(s.setup, '/v1/owner/setup'),
    /** The host's setup code, good only until the first passkey exists. */
    claim: (setupCode: string) => post(s.enrolLink, '/v1/owner/setup', { setupCode }),
    progress: () => get(s.progress, '/v1/owner/setup/progress'),
    deposit: () => get(s.deposit, '/v1/owner/deposit'),
    keys: () => get(s.keys, '/v1/owner/keys'),
    settings: () => get(s.settingsView, '/v1/owner/settings'),
    putSettings: (chains: s.SettingsView['chains']) =>
      stepUp('change_settings', { chains }, (assertion) =>
        call(ignored, 'PUT', '/v1/owner/settings', { chains, assertion }),
      ),

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
    /**
     * loose: the change loosens the policy, so it goes with a passkey assertion. guard-core may also
     * ask for one the panel cannot foresee, such as turning orders off over an open stop (CR-028).
     */
    putPolicy: async (policy: s.PolicyView, loose: boolean) => {
      const path = `/v1/owner/policy/${agent(policy.agentId)}`
      const signed = () =>
        stepUp('loosen_policy', { agentId: policy.agentId, policy }, (assertion) =>
          call(s.policy, 'PUT', path, { policy, assertion }),
        )
      if (loose) {
        return signed()
      }
      try {
        return await call(s.policy, 'PUT', path, { policy })
      } catch (error) {
        if (error instanceof ApiError && error.code === 'step_up_required') {
          return signed()
        }
        throw error
      }
    },
    budget: (id: string) => get(s.budget, `/v1/owner/budget/${agent(id)}`),

    report: (from: Date, to: Date) =>
      get(
        s.report,
        `/v1/owner/report?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`,
      ),
    doctor: () => get(s.doctor, '/v1/owner/doctor'),
    executions: (from: Date, to: Date) =>
      get(
        s.executions,
        `/v1/owner/executions?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`,
      ),
    integrity: () => get(s.integrity, '/v1/owner/executions/integrity'),
    receipts: (from: Date, to: Date) =>
      get(
        s.paymentReceipts,
        `/v1/owner/receipts?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`,
      ),
    proof: (seq: number) => get(s.proof, `/v1/owner/executions/${seq}/proof`),
    passkeys: () => get(s.passkeys, '/v1/owner/passkeys'),
    kill: () => post(s.kill, '/v1/owner/kill'),
    /** CR-022: pauses one agent; the transactions remove its own wallets' limits only. */
    killAgent: (id: string) => post(s.kill, `/v1/owner/agents/${agent(id)}/kill`),

    searchTokens: (q: string, chain: string) =>
      get(s.tokens, `/v1/owner/tokens/search?${new URLSearchParams({ q, chain })}`),
    tokenRisk: (mint: string, chain: string) =>
      get(
        s.tokenRisk,
        `/v1/owner/tokens/${encodeURIComponent(mint)}/risk?${new URLSearchParams({ chain })}`,
      ),
    /** Read-only: the quote this agent's policy would get; it decides and records nothing. */
    quote: (order: Order) => post(s.swapQuote, '/v1/owner/quote', order),
    /** CR-025: always the passkey, over the exact amounts the owner confirmed. */
    trade: (order: Order & { minAmountOut: string }) => {
      const { agentId, chain, tokenIn, tokenOut, amountIn, minAmountOut } = order
      const bound = { agentId, chain, tokenIn, tokenOut, amountIn, minAmountOut }
      return stepUp('manual_trade', bound, (assertion) =>
        post(s.tradeResult, '/v1/owner/trade', { ...order, assertion }),
      )
    },

    trader: (id: string) => get(s.traderStatus, `/v1/owner/trader/${agent(id)}`),
    /** loose: the change does more than turn the trader off or lower a cap, so the passkey. */
    putTrader: (agentId: string, config: TraderConfig, loose: boolean) => {
      const path = `/v1/owner/trader/${agent(agentId)}`
      return loose
        ? stepUp('trader_settings', { agentId, config }, (assertion) =>
            call(s.traderStatus, 'PUT', path, { config, assertion }),
          )
        : call(s.traderStatus, 'PUT', path, { config })
    },
    pauseTrader: (id: string) => post(s.traderStatus, `/v1/owner/trader/${agent(id)}/pause`),
    resumeTrader: (agentId: string) =>
      stepUp('resume_trader', { agentId }, (assertion) =>
        post(s.traderStatus, `/v1/owner/trader/${agent(agentId)}/resume`, { assertion }),
      ),
    ticks: (id: string, before?: string) =>
      get(
        s.traderTicks,
        `/v1/owner/trader/${agent(id)}/ticks${before === undefined ? '' : `?${new URLSearchParams({ before })}`}`,
      ),
    orders: () => get(s.orders, '/v1/owner/orders'),
    /** The passkey signs the whole order, slippage included: no expiry is offered yet. */
    placeOrder: (order: { agentId: string; chain: string; token: string } & NewOrder) =>
      stepUp('place_order', { ...order }, (assertion) =>
        post(s.order, '/v1/owner/orders', { ...order, assertion }),
      ),
    /** A take-profit with the session; a stop is protection, so it takes the passkey (CR-028). */
    cancelOrder: (id: string, kind: string) => {
      const path = `/v1/owner/orders/${encodeURIComponent(id)}/cancel`
      return kind === 'take_profit'
        ? post(s.order, path)
        : stepUp('cancel_order', { orderId: id }, (assertion) => post(s.order, path, { assertion }))
    },

    agentWallets: (id: string) => get(s.agentWallets, `/v1/owner/agents/${agent(id)}/wallets`),
    createAgentWallet: (agentId: string, chain: string) =>
      stepUp('agent_wallet', { agentId, chain }, (assertion) =>
        post(s.agentWallet, `/v1/owner/agents/${agent(agentId)}/wallets`, { chain, assertion }),
      ),

    portfolio: () => get(s.portfolio, '/v1/owner/portfolio'),
    closePositions: () =>
      stepUp('close_positions', {}, (assertion) =>
        post(s.closed, '/v1/owner/positions/close', { assertion }),
      ),

    pushKey: () => get(s.pushKey, '/v1/owner/push/key'),
    subscribe: (subscription: PushSubscriptionJSON) =>
      post(s.pushId, '/v1/owner/push', { subscription }),
    unsubscribe: (id: string) =>
      call(ignored, 'DELETE', `/v1/owner/push/${encodeURIComponent(id)}`),
  }
}

export type OwnerApi = ReturnType<typeof ownerApi>
