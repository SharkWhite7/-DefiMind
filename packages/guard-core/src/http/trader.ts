import type { FastifyInstance } from 'fastify'
import * as repo from '../db/repo.js'
import { getTrader, listTicks, saveTrader, setPaused } from '../db/traders.js'
import { DEFAULT_TRADER, traderNeedsPasskey } from '../domain/trader.js'
import type { PaymentDeps } from '../service/payments.js'
import type { OwnerAction } from '../service/step-up.js'
import { traderStatus } from '../service/trader-status.js'
import { HttpError } from './errors.js'
import { agentIdParam } from './schemas.js'
import { ticksQuery, traderPut, traderResume } from './trader-schemas.js'

/**
 * CR-027, behind the owner's session; no agent route exists. Anything that lets the trader do
 * more needs the passkey; turning it off, lowering a cap or pausing never does.
 */
export function ownerTraderRoutes(
  deps: PaymentDeps,
  keySet: boolean,
  stepUp: (action: OwnerAction, body: unknown, assertion: unknown) => Promise<string>,
) {
  const { db, now } = deps

  function agent(params: unknown): string {
    const { agentId } = agentIdParam.parse(params)
    if (!repo.agentExists(db, agentId)) {
      throw new HttpError(404, 'not_found')
    }
    return agentId
  }

  const status = (agentId: string) => traderStatus(db, agentId, keySet, now())
  const audit = (event: string, agentId: string, detail: Record<string, unknown> = {}) =>
    repo.audit(db, { event, agentId, detail }, now())

  return async (app: FastifyInstance) => {
    app.get('/v1/owner/trader/:agentId', async (request) => status(agent(request.params)))

    app.put('/v1/owner/trader/:agentId', async (request) => {
      const agentId = agent(request.params)
      const { config, assertion } = traderPut.parse(request.body)
      if (config.enabled && !keySet) {
        throw new HttpError(409, 'anthropic_key_missing')
      }
      const prev = getTrader(db, agentId)?.config ?? DEFAULT_TRADER
      // The step-up covers the config as the panel sent it, the one the owner saw.
      const sent = (request.body as { config: unknown }).config
      const passkey = traderNeedsPasskey(prev, config)
        ? await stepUp('trader_settings', { agentId, config: sent }, assertion)
        : undefined
      saveTrader(db, agentId, config, now())
      const { instructions: _, tokens, ...rest } = config
      audit('trader_settings', agentId, { ...rest, tokens: tokens.length, passkey })
      return status(agentId)
    })

    app.post('/v1/owner/trader/:agentId/pause', async (request) => {
      const agentId = agent(request.params)
      if (getTrader(db, agentId) === undefined) {
        throw new HttpError(404, 'not_found')
      }
      setPaused(db, agentId, 'owner', now())
      audit('trader_paused', agentId, { by: 'owner' })
      return status(agentId)
    })

    app.post('/v1/owner/trader/:agentId/resume', async (request) => {
      const agentId = agent(request.params)
      const { assertion } = traderResume.parse(request.body ?? {})
      if (getTrader(db, agentId) === undefined) {
        throw new HttpError(404, 'not_found')
      }
      const passkey = await stepUp('resume_trader', { agentId }, assertion)
      setPaused(db, agentId, null, now())
      audit('trader_resumed', agentId, { passkey })
      return status(agentId)
    })

    app.get('/v1/owner/trader/:agentId/ticks', async (request) => {
      const agentId = agent(request.params)
      const { before } = ticksQuery.parse(request.query)
      return { ticks: listTicks(db, agentId, before) }
    })
  }
}
