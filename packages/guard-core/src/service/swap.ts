import type { ChainAdapter } from '@defimind/onchain'
import type { Amount, PayIntent, Policy } from '@defimind/shared'
import { admit } from '../db/breaker.js'
import { ownerApprovalMethod, recordOwnerApproval, saveClearance } from '../db/receipts.js'
import * as repo from '../db/repo.js'
import { addBought, addSold, addSwapped, bookOf } from '../db/day-book.js'
import { parseAmount, toAmount } from '../domain/amount.js'
import { evaluateTrade, expectedOf, type Trade, type TradeVerdict } from '../domain/trading.js'
import { HttpError } from '../http/errors.js'
import type { QuoteRequest, SwapRequest } from '../http/schemas.js'
import { askOwner } from './approvals.js'
import { needsPasskey } from './passkeys.js'
import { finish, fund, newIntent, reject, shadowed, trip, type PaymentDeps } from './payments.js'
import { policyHash } from './receipts.js'
import { simulate } from './simulate.js'
import { settle } from './swap-settle.js'
import {
  dollarOf,
  fetchQuote,
  gasReason,
  pairOf,
  swapLegs,
  valueOf,
  withQuote,
} from './swap-quote.js'
import { adapterFor, signerKey } from './wallets.js'

/** What the owner is shown for a buy that has drawn nothing yet: it is tested once approved. */
const UNTESTED = {
  summary: 'not tested yet: the hot wallet is funded and the swap tested once you approve',
  balanceChanges: [],
}

/** POST /v1/agent/quote: read-only, so it decides nothing and records nothing. */
export async function quote(deps: PaymentDeps, req: QuoteRequest, policy: Policy) {
  const trading = policy.trading
  const adapter = adapterFor(deps, req.agentId, req.chain)
  if (trading === undefined || !trading.enabled) {
    throw new HttpError(403, 'trading_disabled')
  }
  const pair = pairOf(deps, req)
  if (adapter?.quoteSwap === undefined || pair === undefined) {
    throw new HttpError(400, 'not_tradable')
  }
  const slippage = Math.min(trading.maxSlippageBps, req.maxSlippageBps ?? Infinity)
  const answer = await fetchQuote(adapter, req, slippage)
  if (answer === 'no_route') {
    throw new HttpError(404, 'no_route')
  }
  if (pair.side !== 'swap') {
    return answer
  }
  const value = await valueOf(
    adapter,
    swapLegs(req, answer.minAmountOut),
    trading.maxPriceImpactBps,
    deps.now(),
  )
  return value === undefined ? answer : { ...answer, valueUsd: value.toString() }
}

/**
 * POST /v1/agent/swap: the same pipeline as a payment, with the trading policy (CR-021). `floor`
 * is the least the trade may bring: the minimum the owner saw on their own trade (CR-025), whose
 * passkey already approved it, or an order's trigger less its slippage (CR-026). `shadow` shadows
 * the trade whatever the policy says: an AI trader in shadow mode on a live agent (CR-027).
 */
export async function swap(
  deps: PaymentDeps,
  req: SwapRequest,
  floor?: { minAmountOut: Amount; by: 'owner' | 'order' },
  shadow = false,
): Promise<PayIntent> {
  return deps.serial(signerKey(deps, req.agentId, req.chain), async () => {
    const { db, now } = deps
    const adapter = adapterFor(deps, req.agentId, req.chain)
    const intent = newIntent(
      {
        agentId: req.agentId,
        kind: 'swap',
        chain: req.chain,
        token: req.tokenIn,
        amount: req.amountIn,
        // A swap sends nothing anywhere: what it buys lands in the hot wallet itself.
        recipient: adapter === undefined ? '' : (await adapter.getAllowanceState()).delegate,
        reason: req.reason,
      },
      now(),
    )
    // Saved once there is something to decide: a venue that is down leaves no intent behind.
    const policy = repo.getPolicy(db, req.agentId)
    const pair = pairOf(deps, req)
    const early =
      policy === undefined
        ? 'PAUSED'
        : adapter === undefined || !policy.chains.includes(req.chain)
          ? 'CHAIN_NOT_ALLOWED'
          : policy.trading?.enabled !== true
            ? 'TRADING_DISABLED'
            : adapter.quoteSwap === undefined
              ? 'VENUE_NOT_ALLOWED'
              : pair === undefined
                ? 'TOKEN_NOT_TRADABLE'
                : undefined
    if (early !== undefined || policy?.trading === undefined || !adapter || !pair) {
      return reject(deps, intent, [early ?? 'TRADING_DISABLED'])
    }
    const slippage = Math.min(policy.trading.maxSlippageBps, req.maxSlippageBps ?? Infinity)
    const answer = await fetchQuote(adapter, req, slippage)
    if (answer === 'no_route') {
      return reject(deps, intent, ['NO_EXIT_ROUTE'])
    }
    const priced = withQuote(intent, answer, req.tokenOut)
    if (priced === undefined) {
      return reject(deps, intent, ['SIM_UNEXPECTED_EFFECT'])
    }
    if (floor && parseAmount(answer.minAmountOut) < parseAmount(floor.minAmountOut)) {
      return reject(deps, priced, ['SLIPPAGE_TOO_HIGH'])
    }
    repo.saveIntent(db, priced)
    const gas = await gasReason(adapter, req, pair.side)
    if (gas !== undefined) {
      return reject(deps, priced, [gas])
    }
    const maxImpact = policy.trading.maxPriceImpactBps
    const valueUsd =
      pair.side === 'swap'
        ? await valueOf(adapter, swapLegs(req, answer.minAmountOut), maxImpact, now())
        : undefined
    const trade: Trade = {
      ...pair,
      request: req,
      quote: answer,
      ...(valueUsd === undefined ? {} : { valueUsd }),
    }
    const where = { agentId: req.agentId, chain: req.chain, token: pair.token, spends: pair.spends }
    const book = bookOf(
      db,
      { ...where, dollar: dollarOf(deps, req.chain), day: repo.utcDay(now()) },
      shadow || policy.mode === 'shadow',
    )
    const verdict = evaluateTrade(trade, policy, book, now())
    repo.audit(
      db,
      {
        event: 'policy_evaluated',
        intentId: intent.id,
        agentId: intent.agentId,
        decision: verdict.decision,
        reasons: verdict.reasons,
        detail: {
          side: pair.side,
          ...(verdict.flags.length > 0 ? { flags: verdict.flags } : {}),
          ...(floor ? { via: floor.by } : {}),
        },
      },
      now(),
    )
    if (verdict.reasons.length > 0) {
      return reject(deps, priced, verdict.reasons)
    }
    const how = {
      side: pair.side,
      verdict,
      shadow: shadow || policy.mode === 'shadow',
      policy,
      valueUsd: valueUsd ?? 0n,
    }
    if (floor?.by !== 'owner') {
      return clearSwap(deps, adapter, priced, how)
    }
    recordOwnerApproval(db, intent.id, 'passkey')
    return clearSwap(deps, adapter, priced, how, 'approved')
  })
}

/**
 * The adapter's checks, then the owner or the signature. A buy is topped up before its test run:
 * the adapter cannot draw inside a venue's transaction, and the onchain cap still bounds the draw.
 * Nothing is drawn while the owner has not answered (GC-66): a buy that must wait and that the hot
 * wallet cannot cover goes to the owner untested, and is funded and tested once approved. In
 * shadow nothing is drawn or signed, so a hot wallet short of the dollar records the quote alone.
 */
export async function clearSwap(
  deps: PaymentDeps,
  adapter: ChainAdapter,
  intent: PayIntent,
  how: {
    side: 'buy' | 'sell' | 'swap'
    verdict: TradeVerdict
    shadow: boolean
    policy: Policy
    /** A swap's valuation, which its day counts (CR-026). */
    valueUsd?: bigint
  },
  /** Set when the owner has already answered: their approval, or their own Close. */
  owner?: 'approved' | 'close',
): Promise<PayIntent> {
  const { db, now } = deps
  const short =
    parseAmount(await adapter.getHotWalletBalance(intent.token)) < parseAmount(intent.amount)
  const asks = how.verdict.decision === 'needs_approval'
  if (how.shadow && short) {
    return shadowed(deps, intent, how.verdict.flags, asks)
  }
  // A swap spends only what the wallet holds: it is never topped up from the vault (CR-026).
  if (how.side === 'swap' && short) {
    return reject(deps, intent, ['INSUFFICIENT_POSITION'])
  }
  const waits = how.verdict.decision === 'needs_approval' && owner === undefined
  if (waits && short) {
    const passkey = needsPasskey(deps.passkey, intent)
    return askOwner(deps, intent, UNTESTED, { flags: how.verdict.flags, passkey, untested: true })
  }
  if (how.side === 'buy' && !how.shadow) {
    try {
      await fund(deps, adapter, intent)
    } catch (error) {
      deps.log.error({ err: error, intentId: intent.id }, 'hot wallet top-up failed')
      return finish(deps, intent, { status: 'failed' })
    }
  }
  const { simulation, reasons, error } = await simulate(deps, adapter, intent)
  repo.audit(
    db,
    {
      event: 'simulated',
      intentId: intent.id,
      agentId: intent.agentId,
      reasons,
      detail: { summary: simulation?.summary, error },
    },
    now(),
  )
  if (simulation === undefined || reasons.length > 0) {
    return reject(deps, intent, reasons)
  }
  if (how.shadow) {
    return shadowed(deps, intent, how.verdict.flags, asks)
  }
  if (waits) {
    const passkey = needsPasskey(deps.passkey, intent)
    return askOwner(deps, intent, simulation, { flags: how.verdict.flags, passkey })
  }
  // Again just before signing, once the owner has answered: another trade may have spent the
  // fee coin since the first check. Nothing is counted yet, so a refusal leaves no trace.
  const gas = await gasReason(adapter, { tokenIn: intent.token, amountIn: intent.amount }, how.side)
  if (gas !== undefined) {
    return reject(deps, intent, [gas])
  }
  const limit = how.policy.maxPaymentsPerMinute ?? 10
  // The owner's Close is not an agent looping, so the breaker does not count it.
  if (owner !== 'close' && !admit(db, intent, limit, now())) {
    return trip(deps, intent, limit)
  }
  const approved: PayIntent = { ...intent, status: 'approved', rejectReasons: [] }
  repo.saveIntent(db, approved)
  saveClearance(db, {
    intentId: intent.id,
    policyHash: policyHash(how.policy),
    simulation: simulation.summary,
    approvedBy: owner === undefined ? 'policy' : (ownerApprovalMethod(db, intent.id) ?? 'owner'),
  })
  const day = repo.utcDay(now())
  if (how.side === 'buy') {
    addBought(db, intent.agentId, intent.chain, day, intent.amount)
  } else if (how.side === 'swap') {
    addSwapped(db, intent.agentId, intent.chain, day, toAmount(how.valueUsd ?? 0n))
  } else {
    addSold(db, intent.agentId, intent.chain, day, toAmount(expectedOf(intent.swap)))
  }
  return settle(deps, adapter, approved, how.side, simulation, day)
}
