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
/** Read tools are free of the action cap, so they are bounded per response instead. */
const MAX_READS = 8

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
 * The conversation of one tick, until the model ends its turn, holds, or reaches a cap. `budget` is
 * the tick's token cap, what is left of the day included. `save` records it after every turn, so
 * what it spent and did stays on the record through an error or a crash.
 */
async function converse(
  ctx: TickContext,
  claude: Claude,
  budget: number,
  save: (tick: Ending) => void,
): Promise<Ending> {
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
      if (ctx.guard() !== undefined) {
        return end('stopped: the trader or its agent was paused, turned off or killed')
      }
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
      save(end())
      if (tokensOf(tick.usage) > budget) {
        return end(
          budget < config.maxTokensPerTick ? 'maxTokensPerDay reached' : 'maxTokensPerTick reached',
        )
      }
      if (response.stop_reason !== 'tool_use') {
        return end()
      }
      const results: BetaToolResultBlockParam[] = []
      let reads = 0
      for (const block of response.content) {
        if (block.type !== 'tool_use') {
          continue
        }
        const acts = ACTIONS.has(block.name)
        if (acts && tick.actions.length >= config.maxActionsPerTick) {
          return end('maxActionsPerTick reached')
        }
        // Close, a pause or a kill may land mid-tick: nothing acts after it.
        if (acts && ctx.guard() !== undefined) {
          return end('stopped: the trader or its agent was paused, turned off or killed')
        }
        if (!acts && ++reads > MAX_READS) {
          const content = tagged('tool_data', { error: `at most ${MAX_READS} reads per turn` })
          results.push({ type: 'tool_result', tool_use_id: block.id, content })
          continue
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
      save(end())
    }
    return end('turn limit reached')
  } catch (error) {
    return end(errorDetail(ctx, error), 'error')
  }
}

/** PAUSED once the trader is off or paused, or its agent paused or killed. */
function stopped(deps: PaymentDeps, agentId: string): 'PAUSED' | undefined {
  const row = getTrader(deps.db, agentId)
  const policy = repo.getPolicy(deps.db, agentId)
  const on = row?.config.enabled === true && row.pausedBy === null && policy?.paused === false
  return on ? undefined : 'PAUSED'
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
  const id = randomUUID()
  const today = traderToday(deps.db, agentId, day)
  const spent = skipReason(config, today)
  const tick = (ending: Ending): TraderTick => ({
    id,
    agentId,
    startedAt: startedAt.toISOString(),
    ...ending,
  })
  let ending: Ending
  if (claude === undefined) {
    ending = skipped(config, 'ANTHROPIC_API_KEY is not set')
  } else if (chain === undefined) {
    ending = skipped(config, 'the agent has no Solana chain')
  } else if (spent !== undefined) {
    ending = skipped(config, spent)
  } else {
    const shadow = shadowTrader(deps.db, agentId, config.mode)
    const guard = () => stopped(deps, agentId)
    const ctx = { deps, search: t.search, agentId, chain, config, shadow, guard }
    const budget = Math.min(config.maxTokensPerTick, config.maxTokensPerDay - today.tokens)
    const save = (partial: Ending) => saveTick(deps.db, tick(partial), day, true)
    save(skipped(config, 'running'))
    ending = await converse(ctx, claude, budget, save)
  }
  const done = tick(ending)
  saveTick(deps.db, done, day)
  record(deps, row.streak, done)
  return done
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
