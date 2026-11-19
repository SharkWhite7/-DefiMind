import { type KillTarget, killPageUrl, phantomKillUrl } from '@defimind/shared'
import type { FastifyInstance } from 'fastify'
import { listAgents } from '../db/agents.js'
import * as repo from '../db/repo.js'
import { openRequests } from '../db/requests.js'
import { loosened } from '../domain/loosen.js'
import type { PasskeySetup } from '../service/passkeys.js'
import { type OwnerAction, stepUpChallenge, verifyStepUp } from '../service/step-up.js'
import type { X402Deps } from '../service/x402.js'
import { controls } from './control.js'
import { decideIntent, decideMandateFor } from './decisions.js'
import { HttpError } from './errors.js'
import {
  agentIdParam,
  agentRouteParam,
  idParam,
  intentIdParam,
  ownerChallenge,
  ownerDecision,
  ownerNewAgent,
  ownerPolicy,
  ownerResume,
} from './schemas.js'

type Address = Pick<PasskeySetup, 'rpId' | 'origin'>

/**
 * The owner's panel routes (CR-012), behind the session. What could cost money or widen what an
 * agent may do also needs a fresh passkey assertion over that exact action and body.
 */
export function ownerPanelRoutes(
  deps: X402Deps,
  rp: Address,
  setup: {
    botUrl: string
    databaseUrl: string
    signing?: { page: string; targets: KillTarget[] }
  },
) {
  const { db, now } = deps
  const control = controls(deps, 'panel')

  /** The passkey that signed this action, or a refusal the panel can act on. */
  async function stepUp(action: OwnerAction, body: unknown, assertion: unknown) {
    if (assertion === undefined) {
      throw new HttpError(403, 'step_up_required')
    }
    const passkey = await verifyStepUp(db, rp, action, body, assertion, now())
    if (passkey === undefined) {
      repo.audit(db, { event: 'step_up_refused', detail: { action } }, now())
      throw new HttpError(401, 'passkey_not_verified')
    }
    return passkey.slice(0, 8)
  }

  return async (app: FastifyInstance) => {
    app.post('/v1/owner/challenge', async (request) => {
      const { action, body } = ownerChallenge.parse(request.body)
      return stepUpChallenge(db, rp, action, body ?? null, now())
    })

    app.get('/v1/owner/overview', async (request) => ({
      chains: await control.chains(request.log),
      agents: listAgents(db),
      ...openRequests(db, now()),
    }))

    app.post('/v1/owner/intents/:id/decision', async (request) => {
      const { id } = intentIdParam.parse(request.params)
      const { decision, assertion } = ownerDecision.parse(request.body)
      const passkey =
        decision === 'approve'
          ? await stepUp('approve_intent', { intentId: id }, assertion)
          : undefined
      return decideIntent(deps, id, decision, 'passkey', { via: 'panel', passkey })
    })

    app.post('/v1/owner/mandates/:id/decision', async (request) => {
      const { id } = idParam.parse(request.params)
      const { decision, assertion } = ownerDecision.parse(request.body)
      const passkey =
        decision === 'approve'
          ? await stepUp('approve_mandate', { mandateId: id }, assertion)
          : undefined
      return decideMandateFor(deps, id, decision, { via: 'panel', passkey })
    })

    app.get('/v1/owner/report', async (request) => control.report(request.query))
    app.get('/v1/owner/doctor', async () => control.doctor({ ...setup, fetch: deps.fetch }))
    app.get('/v1/owner/budget/:agentId', async (request) =>
      control.budget(agentIdParam.parse(request.params).agentId),
    )
    app.get('/v1/owner/passkeys', async () => control.passkeys())

    app.get('/v1/owner/agents', async () => control.agents())
    app.post('/v1/owner/agents', async (request) => {
      const { agentId, assertion } = ownerNewAgent.parse(request.body)
      await stepUp('create_agent', { agentId }, assertion)
      return control.addAgent(agentId)
    })
    app.post('/v1/owner/agents/:id/revoke', async (request) =>
      control.revokeAgent(agentRouteParam.parse(request.params).id),
    )

    app.get('/v1/owner/policy/:agentId', async (request) =>
      control.existing(agentIdParam.parse(request.params).agentId),
    )
    app.put('/v1/owner/policy/:agentId', async (request) => {
      const { agentId } = agentIdParam.parse(request.params)
      const { policy, assertion } = ownerPolicy.parse(request.body)
      const next = { agentId, ...policy }
      if (loosened(control.existing(agentId), next).length > 0) {
        // Hashed as the panel sent it, so a field this route ignores still has to match.
        const sent = (request.body as { policy: unknown }).policy
        await stepUp('loosen_policy', { agentId, policy: sent }, assertion)
      }
      return control.putPolicy(next)
    })

    app.post('/v1/owner/pause', async (request) =>
      control.setPaused(agentIdParam.parse(request.body).agentId, true),
    )
    app.post('/v1/owner/resume', async (request) => {
      const { agentId, assertion } = ownerResume.parse(request.body)
      await stepUp('resume', { agentId }, assertion)
      return control.setPaused(agentId, false)
    })

    app.post('/v1/owner/kill', async (request) => {
      const killed = await control.kill(request.log)
      const { signing } = setup
      if (signing === undefined) {
        return killed
      }
      // Stamped now: the signing page refuses a link more than 15 minutes old.
      const issued = now()
      const ownerTransactions = killed.ownerTransactions.map((tx) => {
        const target = signing.targets.find((t) => t.chain === tx.chain)
        return target === undefined
          ? tx
          : {
              ...tx,
              link: phantomKillUrl(signing.page, target, issued),
              pageLink: killPageUrl(signing.page, target, issued),
            }
      })
      return { ...killed, ownerTransactions }
    })
  }
}
