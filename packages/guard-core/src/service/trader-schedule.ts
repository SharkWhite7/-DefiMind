import { parseAmount } from '../domain/amount.js'
import { unitPrice } from '../domain/trader.js'
import { prunePrices, savePrice } from '../db/prices.js'
import { enabledTraders, lastStart } from '../db/traders.js'
import { listPositions } from '../db/trades.js'
import { runTick, type TraderDeps } from './trader.js'

/** What each sample sells: 10 dollars' worth, as the risk card's exit read does. */
const SAMPLE_USD = 10_000_000n

/**
 * Starts every trader that is due, one after another: a tick is due `cadenceMinutes` after the
 * last one started, so a restart never runs a trader early.
 */
export async function dueTicks(t: TraderDeps): Promise<void> {
  const now = t.deps.now().getTime()
  for (const row of enabledTraders(t.deps.db)) {
    if (row.pausedBy !== null) {
      continue
    }
    const last = lastStart(t.deps.db, row.agentId)
    const due = last === undefined || Date.parse(last) + row.config.cadenceMinutes * 60_000 <= now
    if (due) {
      await runTick(t, row.agentId)
    }
  }
}

/** At most this many tokens are sampled every minute, on one deployment (CR-028). */
export const PRICE_FAST_MAX_TOKENS = 20

/** One price sample for every token any trader lists, every 15 minutes. */
export async function samplePrices(t: TraderDeps): Promise<void> {
  const tokens = new Set(enabledTraders(t.deps.db).flatMap((row) => row.config.tokens))
  await sample(t, [...tokens], 15)
  prunePrices(t.deps.db, t.deps.now())
}

/**
 * CR-028: every minute, the tokens of every 5-minute trader, its held positions included, up to
 * PRICE_FAST_MAX_TOKENS: a trader that decides every 5 minutes needs more than one price per 15.
 */
export async function sampleFastPrices(t: TraderDeps): Promise<void> {
  const tokens = new Set(
    enabledTraders(t.deps.db)
      .filter((row) => row.config.cadenceMinutes === 5 && row.pausedBy === null)
      .flatMap((row) => [
        ...row.config.tokens,
        ...listPositions(t.deps.db, row.agentId).map((p) => p.token),
      ]),
  )
  await sample(t, [...tokens].slice(0, PRICE_FAST_MAX_TOKENS), 1)
}

/**
 * Buys 10 dollars' worth of each token on paper, then prices selling it back. A venue that is
 * down leaves a gap, never a guess.
 */
async function sample(t: TraderDeps, tokens: string[], step: 1 | 15): Promise<void> {
  const { db, now, usdc, chains } = t.deps
  for (const [chain, dollar] of usdc) {
    const adapter = chains.get(chain)
    if (adapter?.quoteSwap === undefined || adapter.quoteSell === undefined) {
      continue
    }
    for (const token of tokens) {
      if (token === dollar) {
        continue
      }
      const bought = await adapter
        .quoteSwap({
          tokenIn: dollar,
          tokenOut: token,
          amountIn: SAMPLE_USD.toString(),
          slippageBps: 100,
        })
        .catch(() => undefined)
      const sold =
        bought && (await adapter.quoteSell(token, bought.expectedOut).catch(() => undefined))
      if (bought === undefined || sold === undefined) {
        continue
      }
      const price = unitPrice(
        parseAmount(sold.out),
        parseAmount(bought.expectedOut),
        bought.decimalsOut,
      )
      savePrice(db, chain, token, price, now(), step)
    }
  }
}
