import { canonicalJson } from './canonical.js'
import type { TraderConfig, TraderStatus, TraderTick } from '@defimind/shared'

export const STREAK_PAUSE = 3
export const REASON_MAX = 500

type Caps = 'maxActionsPerTick' | 'maxTicksPerDay' | 'maxTokensPerTick' | 'maxTokensPerDay'
const CAPS: readonly Caps[] = [
  'maxActionsPerTick',
  'maxTicksPerDay',
  'maxTokensPerTick',
  'maxTokensPerDay',
]

/** What a trader never set up reads as: off, in shadow mode, with SPEC's defaults. */
export const DEFAULT_TRADER: TraderConfig = {
  enabled: false,
  mode: 'shadow',
  model: 'claude-opus-5-5',
  effort: 'medium',
  cadenceMinutes: 15,
  tokens: [],
  instructions: '',
  maxActionsPerTick: 3,
  maxTicksPerDay: (24 * 60) / 15,
  maxTokensPerTick: 200_000,
  maxTokensPerDay: 2_000_000,
}

/**
 * Whether saving `next` over `prev` needs the passkey. Only turning the trader off or lowering a cap
 * goes without it (CR-027); new instructions, tokens or a looser cap never do.
 */
export function traderNeedsPasskey(prev: TraderConfig, next: TraderConfig): boolean {
  if (next.enabled && !prev.enabled) {
    return true
  }
  if (CAPS.some((cap) => next[cap] > prev[cap])) {
    return true
  }
  // Everything else must be as it was: put back what may change freely, then compare.
  const kept = {
    ...next,
    enabled: prev.enabled,
    ...Object.fromEntries(CAPS.map((c) => [c, prev[c]])),
  }
  return canonicalJson(kept) !== canonicalJson(prev)
}

/** Why a tick must not start: the day's ticks or tokens are spent. */
export function skipReason(
  config: TraderConfig,
  today: { ticks: number; tokens: number },
): string | undefined {
  if (today.ticks >= config.maxTicksPerDay) {
    return 'maxTicksPerDay reached'
  }
  if (today.tokens >= config.maxTokensPerDay) {
    return 'maxTokensPerDay reached'
  }
  return undefined
}

export interface Streak {
  kind: 'error' | 'refused' | null
  count: number
}

/** Three ticks in a row that end the same bad way pause the trader; anything else starts over. */
export function nextStreak(
  streak: Streak,
  outcome: TraderTick['outcome'],
): Streak & { pause?: 'errors' | 'refusals' } {
  if (outcome !== 'error' && outcome !== 'refused') {
    return { kind: null, count: 0 }
  }
  const count = streak.kind === outcome ? streak.count + 1 : 1
  if (count < STREAK_PAUSE) {
    return { kind: outcome, count }
  }
  return { kind: outcome, count, pause: outcome === 'error' ? 'errors' : 'refusals' }
}

/** The model's words are display only: bounded, and never read back into a decision. */
export function clip(text: string): string {
  return text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 1)}…`
}

/** A stored pause wins; an agent paused by its own policy shows as such without being stored. */
export function traderState(
  config: TraderConfig,
  pausedBy: TraderStatus['pausedBy'] | null,
  agentPaused: boolean,
): Pick<TraderStatus, 'state' | 'pausedBy'> {
  if (!config.enabled) {
    return { state: 'off' }
  }
  const by = pausedBy ?? (agentPaused ? 'agent_paused' : undefined)
  return by === undefined ? { state: 'running' } : { state: 'paused', pausedBy: by }
}

/** Every request's tokens, input side included: the caps bound what the owner pays for. */
export function tokensOf(usage: TraderTick['usage']): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}
