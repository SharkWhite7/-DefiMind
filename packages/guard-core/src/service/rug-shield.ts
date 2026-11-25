import { SwapUnavailable } from '@defimind/onchain'
import type { Policy, Position } from '@defimind/shared'
import { openOrders } from '../db/orders.js'
import * as repo from '../db/repo.js'
import { getBaseline, saveBaseline } from '../db/shield.js'
import { getPosition, listPositions } from '../db/trades.js'
import { parseAmount, toAmount } from '../domain/amount.js'
import { newRisk, reference, shieldFloor, type Watch } from '../domain/shield.js'
import { WSOL } from '../domain/valuation.js'
import { cancelOrder } from './orders.js'
import type { PaymentDeps } from './payments.js'
import { swap } from './swap.js'
import { adapterFor } from './wallets.js'

export interface ShieldRules {
  checkMs: number
  confirmChecks: number
  supplyJumpBps: number
  maxLossBps: number
  /** Positions worth less than this, in the chain's dollar atomic units, are skipped. */
  dustUsd: bigint
}

type Held = Position & { agentId: string }
type State = Watch & { until?: number; tries: number; told?: boolean; shadowed?: boolean }

const RETRY_MS = 15 * 60_000
const MAX_RETRY_MS = 6 * 60 * 60_000

/**
 * The rug shield (CR-028). Each check reads every held token's mint, from the chain alone, then
 * quotes its whole position. It sells, as a protective sell, when a new risk shows on two checks
 * in a row, or when the exit stays past the impact limit for a whole run after good ones. Never
 * below half the recent good value, and never a paused agent's tokens: the owner is only told.
 * The runs are kept in memory, so a restart starts them over.
 */
export function rugShield(deps: PaymentDeps, rules: ShieldRules) {
  const states = new Map<string, State>()

  async function check(held: Held): Promise<void> {
    const { db } = deps
    const policy = repo.getPolicy(db, held.agentId)
    const adapter = adapterFor(deps, held.agentId, held.chain)
    if (
      policy === undefined ||
      !(policy.trading?.rugShield?.enabled ?? true) ||
      held.token === WSOL ||
      held.token === deps.usdc.get(held.chain) ||
      adapter?.quoteSell === undefined ||
      adapter.mintFacts === undefined
    ) {
      return
    }
    const key = `${held.agentId}|${held.chain}|${held.token}`
    const state = states.get(key) ?? { goods: [], bad: 0, tries: 0 }
    states.set(key, state)
    // The mint first, and on its own: a busy venue must never blind the new-risk rule.
    const where = { agentId: held.agentId, chain: held.chain, token: held.token }
    const read = await adapter.mintFacts(held.token).catch(() => undefined)
    let confirmed: string | undefined
    if (read !== undefined) {
      const base = getBaseline(db, where)
      const risk = base === undefined ? undefined : newRisk(base, read, rules.supplyJumpBps)
      if (base === undefined) {
        saveBaseline(db, where, read, deps.now())
      }
      confirmed = risk !== undefined && risk === state.risk ? risk : undefined
      state.risk = risk
    }
    if (policy.paused || policy.trading?.enabled !== true) {
      if (confirmed !== undefined) {
        tell(held, state, confirmed)
      }
      return
    }
    state.told = false
    // A paper sell said nothing about a live agent: once it goes live, the shield acts again.
    if (policy.mode !== 'shadow') {
      state.shadowed = false
    }
    const quoted = await adapter.quoteSell(held.token, held.amount).then(
      (q) => q,
      (error: unknown) =>
        error instanceof SwapUnavailable && error.code === 'no_route' ? null : undefined,
    )
    // A venue error is no fact either way: the liquidity run waits for the next check.
    const out = quoted === undefined || quoted === null ? 0n : parseAmount(quoted.out)
    if (quoted !== undefined) {
      if (quoted !== null && out < rules.dustUsd && state.goods.length === 0) {
        return
      }
      const maxImpact = policy.trading.maxPriceImpactBps
      if (quoted !== null && quoted.priceImpactBps <= maxImpact) {
        const amount = parseAmount(held.amount)
        state.goods = [...state.goods, { out, amount }].slice(-rules.confirmChecks)
        state.bad = 0
      } else if (state.goods.length > 0) {
        state.bad += 1
      }
    }
    // With no quote and no good one before it, the floor would be nothing: wait for a quote.
    const blind = quoted === undefined && state.goods.length === 0
    if (confirmed !== undefined && !blind) {
      await fire(held, policy, state, 'new_risk', confirmed, out)
    } else if (state.bad >= rules.confirmChecks) {
      await fire(held, policy, state, 'liquidity_gone', 'its liquidity is gone', out)
    }
  }

  /** A paused agent is never sold: the owner hears it once, and Close positions stays the way out. */
  function tell(held: Held, state: State, why: string) {
    if (state.told === true) {
      return
    }
    state.told = true
    const detail = { token: held.token, why, paused: true }
    repo.audit(deps.db, { event: 'rug_shield', agentId: held.agentId, detail }, deps.now())
    deps.push?.shield({
      agentId: held.agentId,
      chain: held.chain,
      amount: held.amount,
      paused: true,
    })
  }

  async function fire(
    held: Held,
    policy: Policy,
    state: State,
    rule: 'new_risk' | 'liquidity_gone',
    why: string,
    out: bigint,
  ): Promise<void> {
    const { db, now } = deps
    state.risk = undefined
    state.bad = 0
    // A paper sell changes nothing on paper either: once is enough.
    if (state.shadowed === true || (state.until !== undefined && now().getTime() < state.until)) {
      return
    }
    // A stop may have sold part of it since the check began.
    const booked = getPosition(db, held.agentId, held.chain, held.token).amount
    const held0 = parseAmount(held.amount)
    const amount = booked < held0 ? booked : held0
    if (amount === 0n) {
      return
    }
    const ref = reference(state.goods, amount)
    const floor = shieldFloor(out, policy.trading?.maxSlippageBps ?? 0, ref, rules.maxLossBps)
    const request = {
      agentId: held.agentId,
      chain: held.chain,
      tokenIn: held.token,
      tokenOut: deps.usdc.get(held.chain) ?? '',
      amountIn: toAmount(amount),
      reason: `rug shield: ${why}`,
    }
    const intent = await swap(deps, request, { minAmountOut: toAmount(floor), by: 'shield' }).catch(
      (error: unknown) => {
        deps.log.error({ err: error, token: held.token }, 'rug shield sell failed')
        return undefined
      },
    )
    const sold = intent?.status === 'executed'
    state.shadowed = intent?.status === 'shadowed'
    // The stops go only once the token is gone: a refused sell must not leave it unprotected.
    if (sold) {
      for (const order of openOrders(db, held.agentId).filter((o) => o.token === held.token)) {
        cancelOrder(deps, order, 'rug_shield')
      }
    }
    const status = intent?.status ?? 'failed'
    repo.audit(
      db,
      {
        event: 'rug_shield',
        agentId: held.agentId,
        ...(intent === undefined ? {} : { intentId: intent.id }),
        detail: { token: held.token, rule, why, status },
      },
      now(),
    )
    const done = sold || state.shadowed
    state.tries = done ? 0 : state.tries + 1
    if (done || state.tries === 1) {
      deps.push?.shield({
        agentId: held.agentId,
        chain: held.chain,
        amount: toAmount(amount),
        ...(intent === undefined ? {} : { intentId: intent.id }),
        ...(done ? {} : { failed: true }),
      })
    }
    if (!done) {
      const wait = Math.min(RETRY_MS * 2 ** (state.tries - 1), MAX_RETRY_MS)
      state.until = now().getTime() + wait
    }
  }

  return {
    async tick(): Promise<void> {
      for (const held of listPositions(deps.db)) {
        try {
          await check(held)
        } catch (error) {
          deps.log.error({ err: error, token: held.token }, 'rug shield check failed')
        }
      }
    },
  }
}
