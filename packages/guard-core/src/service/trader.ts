import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { isSvm, type TraderAction, type TraderConfig, type TraderTick } from '@defimind/shared'
import { randomUUID } from 'node:crypto'
import type { Claude, ClaudeRequest } from '../adapters/claude.js'
import type { TokenSearch } from '../adapters/jupiter-tokens.js'
import * as repo from '../db/repo.js'
import { getTrader, saveTick, setPaused, setStreak, traderToday } from '../db/traders.js'
import { clip, nextStreak, skipReason, type Streak, tokensOf } from '../domain/trader.js'
import type { PaymentDeps } from './payments.js'
import { portfolio } from './portfolio.js'
import { shadowTrader } from './trader-status.js'
import { ACTIONS, TOOLS } from './trader-tool-defs.js'
import { runTool, type TickContext } from './trader-tools.js'
import { systemBlocks, tagged, tickMessage } from './trader-prompt.js'

export interface TraderDeps {
  deps: PaymentDeps
  /** Unset without ANTHROPIC_API_KEY: every tick is skipped. */
  claude?: Claude
  search: TokenSearch
}

const MAX_TOKENS = 16_000
/** A ceiling on round trips, whatever the token cap: a model that never ends its turn stops here. */
const MAX_TURNS = 12
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

type Ending = Omit<TraderTick, 'id' | 'agentId' | 'startedAt'>

function request(config: TraderConfig, messages: BetaMessageParam[]): ClaudeRequest {
  return {
    model: config.model,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: config.effort },
    system: systemBlocks(config),
    tools: TOOLS,
    // A forced tool_choice is refused on these models; the prompt asks for hold instead.
    tool_choice: { type: 'auto' },
    messages,
    // Haiku 5.5 has no server-side fallback.
    ...(config.model === 'claude-haiku-5-5'
      ? {}
      : { betas: [FALLBACK_BETA], fallbacks: 'default' as const }),
  }
}

function lastText(message: BetaMessage): string | undefined {
  return message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).at(-1)
}

const pipelineRefused = (a: TraderAction) =>
  a.rejectReasons.length > 0 || a.status === 'rejected' || a.status === 'failed'

/** An API error is counted by its class, never matched on its text; anything else is a bug. */
function errorDetail(ctx: TickContext, error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    ctx.deps.log.warn({ agentId: ctx.agentId, status: error.status }, 'trader: Claude API error')
    return `Claude API error ${error.status ?? 'connection'}`
  }
  ctx.deps.log.error({ err: error, agentId: ctx.agentId }, 'trader tick failed')
  return 'internal error'
}

/**
 * The conversation of one tick, until the model ends its turn, holds, or reaches a cap. What it
 * spent and did before an error stays on the record.
 */
async function converse(ctx: TickContext, claude: Claude): Promise<Ending> {
  const { config, deps, agentId } = ctx
  const tick: Ending = {
    outcome: 'held',
    actions: [],
    reason: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    model: config.model,
  }
  const end = (detail?: string, outcome?: TraderTick['outcome']): Ending => ({
    ...tick,
    outcome:
      outcome ??
      (tick.actions.length === 0
        ? 'held'
        : tick.actions.every(pipelineRefused)
          ? 'refused'
          : 'acted'),
    ...(detail === undefined ? {} : { detail }),
  })
  const data = {
    now: deps.now(),
    tokens: config.tokens,
    maxActionsPerTick: config.maxActionsPerTick,
    portfolio: portfolio(deps.db, agentId, deps.now()),
    limits: repo.getPolicy(deps.db, agentId)?.trading ?? null,
  }
  const messages: BetaMessageParam[] = [{ role: 'user', content: tickMessage(data) }]
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await claude(request(config, messages))
      const { usage } = response
      tick.model = response.model
      tick.usage.input += usage.input_tokens
      tick.usage.output += usage.output_tokens
      tick.usage.cacheRead += usage.cache_read_input_tokens ?? 0
      tick.usage.cacheWrite += usage.cache_creation_input_tokens ?? 0
      tick.reason = clip(lastText(response) ?? tick.reason)
      // Checked before any tool runs: a refused or cut-off turn acts on nothing it asked for.
      if (response.stop_reason === 'refusal') {
        return end('the model refused', 'refused')
      }
      if (response.stop_reason === 'max_tokens') {
        return end('the model ran out of output tokens', 'error')
      }
      if (tokensOf(tick.usage) > config.maxTokensPerTick) {
        return end('maxTokensPerTick reached')
      }
      if (response.stop_reason !== 'tool_use') {
        return end()
      }
      const results: BetaToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') {
          continue
        }
        if (ACTIONS.has(block.name) && tick.actions.length >= config.maxActionsPerTick) {
          return end('maxActionsPerTick reached')
        }
        const outcome = await runTool(ctx, block.name, block.input)
        if (outcome.action !== undefined) {
          tick.actions.push(outcome.action)
        }
        if (outcome.hold !== undefined) {
          tick.reason = clip(outcome.hold)
          return end()
        }
        const content = tagged('tool_data', outcome.content)
        results.push({ type: 'tool_result', tool_use_id: block.id, content })
      }
      // Echoed as received, thinking and fallback blocks included: the API checks them.
      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: results })
    }
    return end('turn limit reached')
  } catch (error) {
    return end(errorDetail(ctx, error), 'error')
  }
}

/** The Solana chain the trader trades on: the first the agent may use that has a dollar. */
function chainOf(deps: PaymentDeps, agentId: string): string | undefined {
  const chains = repo.getPolicy(deps.db, agentId)?.chains ?? []
  return chains.find((chain) => isSvm(chain) && deps.usdc.has(chain))
}

function skipped(config: TraderConfig, detail: string): Ending {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return { outcome: 'skipped', actions: [], reason: '', usage, model: config.model, detail }
}

/**
 * One tick of one agent's trader, recorded whatever happens. Nothing runs for a trader that is off
 * or paused, or whose agent is paused; a spent day records a skipped tick.
 */
export async function runTick(t: TraderDeps, agentId: string): Promise<TraderTick | undefined> {
  const { deps, claude } = t
  const row = getTrader(deps.db, agentId)
  const paused = repo.getPolicy(deps.db, agentId)?.paused ?? true
  if (row === undefined || !row.config.enabled || row.pausedBy !== null || paused) {
    return undefined
  }
  const { config } = row
  const startedAt = deps.now()
  const day = repo.utcDay(startedAt)
  const chain = chainOf(deps, agentId)
  const spent = skipReason(config, traderToday(deps.db, agentId, day))
  let ending: Ending
  if (claude === undefined) {
    ending = skipped(config, 'ANTHROPIC_API_KEY is not set')
  } else if (chain === undefined) {
    ending = skipped(config, 'the agent has no Solana chain')
  } else if (spent !== undefined) {
    ending = skipped(config, spent)
  } else {
    const shadow = shadowTrader(deps.db, agentId, config.mode)
    ending = await converse({ deps, search: t.search, agentId, chain, config, shadow }, claude)
  }
  const tick: TraderTick = {
    id: randomUUID(),
    agentId,
    startedAt: startedAt.toISOString(),
    ...ending,
  }
  saveTick(deps.db, tick, day)
  record(deps, row.streak, tick)
  return tick
}

/** The decision log, and the self-pause after three errors or refusals in a row. */
function record(deps: PaymentDeps, streak: Streak, tick: TraderTick): void {
  const { db, now } = deps
  const { agentId, id, outcome, model, usage, actions } = tick
  const detail = { id, outcome, model, tokens: tokensOf(usage), actions: actions.length }
  repo.audit(db, { event: 'trader_tick', agentId, detail }, now())
  if (outcome === 'skipped') {
    return
  }
  const next = nextStreak(streak, outcome)
  setStreak(db, agentId, next)
  if (next.pause !== undefined) {
    setPaused(db, agentId, next.pause, now())
    repo.audit(db, { event: 'trader_paused', agentId, detail: { by: next.pause } }, now())
    deps.push?.traderPaused(agentId)
  }
}
