import type { PayIntent, SwapQuote } from '@defimind/shared'
import * as repo from '../db/repo.js'
import { bookOf } from '../db/trades.js'
import { evaluateTrade } from '../domain/trading.js'
import { reject, type PaymentDeps } from './payments.js'
import { clearSwap } from './swap.js'
import { dollarOf, gasReason, pairOf, swapLegs, valueOf } from './swap-quote.js'
import { adapterFor } from './wallets.js'

/**
 * A swap the owner approved. The policy runs again, since the agent may have been paused or the
 * day's budget spent meanwhile, then the adapter builds and checks a fresh transaction, which must
 * still give the minimum the owner saw for the amount the owner saw. Nothing is re-quoted into a
 * lower minimum.
 */
export async function sendApprovedSwap(deps: PaymentDeps, first: PayIntent): Promise<PayIntent> {
  return deps.serial(first.agentId, async () => {
    const { db, now } = deps
    const intent = repo.getIntent(db, first.id)
    if (intent?.status !== 'approved' || intent.kind !== 'swap' || intent.swap === undefined) {
      return intent ?? first
    }
    const details = intent.swap
    const adapter = adapterFor(deps, intent.agentId, intent.chain)
    const policy = repo.getPolicy(db, intent.agentId)
    const request = {
      agentId: intent.agentId,
      chain: intent.chain,
      tokenIn: intent.token,
      tokenOut: details.tokenOut,
      amountIn: intent.amount,
    }
    const pair = pairOf(deps, request)
    if (adapter === undefined || policy === undefined || pair === undefined) {
      return reject(deps, intent, ['CHAIN_NOT_ALLOWED'])
    }
    // The terms the owner approved, as a quote: its age and its minimum are the intent's own.
    const quote: SwapQuote = {
      ...request,
      venue: details.venue,
      expectedOut: details.minAmountOut,
      minAmountOut: details.minAmountOut,
      slippageBps: details.slippageBps,
      priceImpactBps: details.priceImpactBps,
      exitImpactBps: 0,
      risks: [],
      flags: [],
      quotedAt: now().toISOString(),
      decimalsIn: details.decimalsIn,
      decimalsOut: details.decimalsOut,
    }
    const gas = await gasReason(adapter, request)
    if (gas !== undefined) {
      return reject(deps, intent, [gas])
    }
    // A swap is valued again: the prices the owner saw may have moved (CR-026).
    const maxImpact = policy.trading?.maxPriceImpactBps ?? 0
    const valueUsd =
      pair.side === 'swap'
        ? await valueOf(adapter, swapLegs(request, details.minAmountOut), maxImpact, now())
        : undefined
    const where = {
      agentId: intent.agentId,
      chain: intent.chain,
      token: pair.token,
      spends: pair.spends,
    }
    const day = repo.utcDay(now())
    const book = bookOf(db, { ...where, dollar: dollarOf(deps, intent.chain), day }, false)
    const trade = { ...pair, request, quote, ...(valueUsd === undefined ? {} : { valueUsd }) }
    const verdict = evaluateTrade(trade, policy, book, now())
    if (verdict.reasons.length > 0) {
      return reject(deps, intent, verdict.reasons)
    }
    const how = { side: pair.side, verdict, shadow: false, policy, valueUsd: valueUsd ?? 0n }
    return clearSwap(deps, adapter, intent, how, 'approved')
  })
}
