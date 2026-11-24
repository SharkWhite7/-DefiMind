import type { ChainAdapter } from '@defimind/onchain'
import type { PayIntent, SimulationResult } from '@defimind/shared'
import { applyTrade } from '../db/trades.js'
import { parseAmount } from '../domain/amount.js'
import { net } from '../domain/simulation.js'
import { finish, type PaymentDeps } from './payments.js'

/**
 * Signs the swap the adapter simulated, and books it at cost. What a buy brought in is the
 * simulation's tokenOut delta, which the adapter checked against the minimum before we got here.
 */
export async function settle(
  deps: PaymentDeps,
  adapter: ChainAdapter,
  intent: PayIntent,
  side: 'buy' | 'sell',
  simulation: SimulationResult,
): Promise<PayIntent> {
  const details = intent.swap
  if (details === undefined) {
    return finish(deps, intent, { status: 'failed' })
  }
  let txId: string
  try {
    txId = await adapter.send(intent)
  } catch (error) {
    deps.log.error({ err: error, intentId: intent.id }, 'swap send failed')
    return finish(deps, intent, { status: 'failed' })
  }
  const position =
    side === 'buy'
      ? {
          token: details.tokenOut,
          amount: net(simulation, details.tokenOut),
          cost: parseAmount(intent.amount),
          decimals: details.decimalsOut,
          ...(details.symbolOut === undefined ? {} : { symbol: details.symbolOut }),
        }
      : {
          token: intent.token,
          amount: parseAmount(intent.amount),
          cost: 0n,
          decimals: details.decimalsIn,
          ...(details.symbolIn === undefined ? {} : { symbol: details.symbolIn }),
        }
  applyTrade(
    deps.db,
    { agentId: intent.agentId, chain: intent.chain, side, ...position },
    deps.now(),
  )
  return finish(deps, intent, { status: 'executed', txId })
}
