import { parseAmount } from '../domain/amount.js'
import { unitPrice } from '../domain/trader.js'
import { prunePrices, savePrice } from '../db/prices.js'
import { enabledTraders, listTicks } from '../db/traders.js'
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
    const [last] = listTicks(t.deps.db, row.agentId)
    const due =
      last === undefined || Date.parse(last.startedAt) + row.config.cadenceMinutes * 60_000 <= now
    if (due) {
      await runTick(t, row.agentId)
    }
  }
}

/**
 * One price sample for every token any trader lists: buy 10 dollars' worth on paper, then price
 * selling it back. A venue that is down leaves a gap, never a guess.
 */
export async function samplePrices(t: TraderDeps): Promise<void> {
  const { db, now, usdc, chains } = t.deps
  const tokens = new Set(enabledTraders(db).flatMap((row) => row.config.tokens))
  for (const [chain, dollar] of usdc) {
    const adapter = chains.get(chain)
    if (adapter?.quoteSwap === undefined || adapter.quoteSell === undefined) {
      continue
    }
    for (const token of tokens) {
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
      savePrice(db, chain, token, price, now())
    }
  }
  prunePrices(db, now())
}
