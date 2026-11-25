import type { TraderReport, TraderStatus } from '@defimind/shared'
import type { Db } from '../db/client.js'
import * as repo from '../db/repo.js'
import { listPositions } from '../db/trades.js'
import { getTrader, traderIntents, traderToday } from '../db/traders.js'
import { DEFAULT_TRADER, traderState } from '../domain/trader.js'

/** Whether trades are shadowed: the trader's own mode, or its agent's. */
export function shadowTrader(db: Db, agentId: string, mode: 'shadow' | 'live'): boolean {
  return mode === 'shadow' || repo.getPolicy(db, agentId)?.mode === 'shadow'
}

/**
 * Landed trades only, read from the intents the ticks made: a buy that waited for the owner
 * counts once it went through. Profit and loss is left out until positions carry it.
 */
function report(db: Db, agentId: string, shadow: boolean): TraderReport {
  const landed = shadow ? 'shadowed' : 'executed'
  const trades = traderIntents(db, agentId).filter(
    (id) => repo.getIntent(db, id)?.status === landed,
  ).length
  return {
    trades,
    positions: listPositions(db, agentId).map(({ agentId: _, ...position }) => position),
    shadow,
  }
}

export function traderStatus(db: Db, agentId: string, keySet: boolean, now: Date): TraderStatus {
  const row = getTrader(db, agentId)
  const config = row?.config ?? DEFAULT_TRADER
  const paused = repo.getPolicy(db, agentId)?.paused ?? true
  return {
    config,
    ...traderState(config, row?.pausedBy ?? null, paused),
    keySet,
    today: traderToday(db, agentId, repo.utcDay(now)),
    report: report(db, agentId, shadowTrader(db, agentId, config.mode)),
  }
}
