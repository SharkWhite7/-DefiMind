import { SwapUnavailable } from '@defimind/onchain'
import type { Position } from '@defimind/shared'
import { openOrders } from '../db/orders.js'
import * as repo from '../db/repo.js'
import { getBaseline, saveBaseline } from '../db/shield.js'
import { listPositions } from '../db/trades.js'
import { parseAmount, toAmount } from '../domain/amount.js'
import { type MintFacts, newRisk, shieldFloor, type Watch } from '../domain/shield.js'
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

const RETRY_MS = 15 * 60_000

const facts = (risk: MintFacts): MintFacts => ({
  freezeAuthority: risk.freezeAuthority,
  mintAuthority: risk.mintAuthority,
  extensions: risk.extensions,
  supply: risk.supply,
})

/**
 * The rug shield (CR-028). Every check reads each held token's mint and quotes its whole position.
 * It sells, as a protective sell, when a new risk shows on two checks in a row, or when the exit
 * stays past the impact limit for a whole run after a good one. It never sells a paused agent's
 * tokens, and only tells the owner. The runs are kept in memory, so a restart starts them over.
 */
export function rugShield(deps: PaymentDeps, rules: ShieldRules) {
  const watches = new Map<string, Watch & { until?: number; told?: boolean }>()

  async function check(held: Held): Promise<void> {
    const { db } = deps
    const policy = repo.getPolicy(db, held.agentId)
    const adapter = adapterFor(deps, held.agentId, held.chain)
    if (
      policy === undefined ||
      !(policy.trading?.rugShield?.enabled ?? true) ||
      held.token === WSOL ||
      adapter?.quoteSell === undefined ||
      adapter.tokenRisk === undefined
    ) {
      return
    }
    const key = `${held.agentId}|${held.chain}|${held.token}`
    const watch = watches.get(key) ?? { bad: 0 }
    watches.set(key, watch)
    const quoted = await adapter.quoteSell(held.token, held.amount).then(
      (q) => q,
      (error: unknown) =>
        error instanceof SwapUnavailable && error.code === 'no_route' ? null : undefined,
    )
    // A venue error is no fact either way: the run waits for the next check.
    if (quoted === undefined) {
      return
    }
    const out = quoted === null ? 0n : parseAmount(quoted.out)
    if (quoted !== null && out < rules.dustUsd && watch.lastGood === undefined) {
      return
    }
    const maxImpact = policy.trading?.maxPriceImpactBps ?? 0
    if (quoted !== null && quoted.priceImpactBps <= maxImpact) {
      watch.lastGood = out
      watch.bad = 0
    } else if (watch.lastGood !== undefined) {
      watch.bad += 1
    }
    const where = { agentId: held.agentId, chain: held.chain, token: held.token }
    const read = await adapter.tokenRisk(held.token).catch(() => undefined)
    let risk: string | undefined
    if (read !== undefined) {
      const base = getBaseline(db, where)
      if (base === undefined) {
        saveBaseline(db, where, facts(read), deps.now())
      } else {
        risk = newRisk(base, facts(read), rules.supplyJumpBps)
      }
    }
    const confirmedRisk = risk !== undefined && risk === watch.risk ? risk : undefined
    if (read !== undefined) {
      watch.risk = risk
    }
    if (confirmedRisk !== undefined) {
      await fire(held, watch, 'new_risk', confirmedRisk, out)
    } else if (watch.bad >= rules.confirmChecks) {
      await fire(held, watch, 'liquidity_gone', 'its liquidity is gone', out)
    }
  }

  async function fire(
    held: Held,
    watch: Watch & { until?: number; told?: boolean },
    rule: 'new_risk' | 'liquidity_gone',
    why: string,
    out: bigint,
  ): Promise<void> {
    const { db, now } = deps
    if (watch.until !== undefined && now().getTime() < watch.until) {
      return
    }
    const policy = repo.getPolicy(db, held.agentId)
    const event = { agentId: held.agentId, chain: held.chain, amount: held.amount }
    const detail = { token: held.token, rule, why }
    if (policy === undefined || policy.paused || policy.trading?.enabled !== true) {
      // Close positions stays the way out; the shield only says so, once.
      if (watch.told !== true) {
        repo.audit(
          db,
          { event: 'rug_shield', agentId: held.agentId, detail: { ...detail, paused: true } },
          now(),
        )
        deps.push?.shield({ ...event, paused: true })
        watch.told = true
      }
      return
    }
    for (const order of openOrders(db, held.agentId).filter((o) => o.token === held.token)) {
      cancelOrder(deps, order, 'rug_shield')
    }
    const slippage = policy.trading.maxSlippageBps
    const lastGood = rule === 'liquidity_gone' ? watch.lastGood : undefined
    const floor = shieldFloor(out, slippage, lastGood, rules.maxLossBps)
    const request = {
      agentId: held.agentId,
      chain: held.chain,
      tokenIn: held.token,
      tokenOut: deps.usdc.get(held.chain) ?? '',
      amountIn: held.amount,
      reason: `rug shield: ${why}`,
    }
    const intent = await swap(deps, request, { minAmountOut: toAmount(floor), by: 'shield' }).catch(
      (error: unknown) => {
        deps.log.error({ err: error, token: held.token }, 'rug shield sell failed')
        return undefined
      },
    )
    const sold = intent?.status === 'executed' || intent?.status === 'shadowed'
    repo.audit(
      db,
      {
        event: 'rug_shield',
        agentId: held.agentId,
        ...(intent === undefined ? {} : { intentId: intent.id }),
        detail: { ...detail, status: intent?.status ?? 'failed' },
      },
      now(),
    )
    deps.push?.shield({
      ...event,
      ...(intent === undefined ? {} : { intentId: intent.id }),
      ...(sold ? {} : { failed: true }),
    })
    watch.risk = undefined
    watch.bad = 0
    if (!sold) {
      watch.until = now().getTime() + RETRY_MS
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
