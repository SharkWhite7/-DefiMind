/** CR-027's TraderConfig, as guard-core returns it. */
export interface TraderConfig {
  enabled: boolean
  mode: 'shadow' | 'live'
  model: string
  effort: 'low' | 'medium' | 'high'
  cadenceMinutes: 5 | 15 | 60
  tokens: string[]
  instructions: string
  template?: { id: string; version: number } | undefined
  maxActionsPerTick: number
  maxTicksPerDay: number
  maxTokensPerTick: number
  maxTokensPerDay: number
}

export const MODELS = [
  ['claude-opus-5-5', 'Opus 5.5 (default)'],
  ['claude-sonnet-5-5', 'Sonnet 5.5 (cheaper)'],
  ['claude-haiku-5-5', 'Haiku 5.5 (cheapest)'],
] as const

export const CADENCES = [5, 15, 60] as const

/** SPEC's defaults for a trader that was never set up. */
export function defaultConfig(): TraderConfig {
  return {
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
}

const CAPS = ['maxActionsPerTick', 'maxTicksPerDay', 'maxTokensPerTick', 'maxTokensPerDay'] as const

/**
 * Whether saving needs the passkey: always, except when the change only turns the trader off or
 * lowers a cap (SPEC, CR-027). A trader never set up counts as off, at the defaults.
 */
export function traderLoosens(before: TraderConfig | undefined, after: TraderConfig): boolean {
  const was = before ?? defaultConfig()
  const keys = new Set([...Object.keys(was), ...Object.keys(after)]) as Set<keyof TraderConfig>
  return [...keys].some((key) => {
    if (JSON.stringify(was[key]) === JSON.stringify(after[key])) {
      return false
    }
    if (key === 'enabled') {
      return after.enabled
    }
    if ((CAPS as readonly string[]).includes(key)) {
      return Number(after[key]) > Number(was[key])
    }
    return true
  })
}

/** What the owner types: the instructions, the mints and the actions per tick. */
export function fromTraderForm(
  before: TraderConfig,
  form: { instructions: string; tokens: string; maxActionsPerTick: string },
): Omit<TraderConfig, 'enabled' | 'mode' | 'model' | 'effort' | 'cadenceMinutes'> | string {
  const instructions = form.instructions.trim()
  if (instructions.length === 0) {
    return 'Instructions: write what the trader should do, or pick a ready-made strategy.'
  }
  if (instructions.length > 2000) {
    return `Instructions: at most 2000 characters (now ${instructions.length}).`
  }
  const tokens = [...new Set(form.tokens.split(/[\s,]+/).filter(Boolean))]
  if (tokens.length === 0) {
    return 'Tokens: choose at least one token the trader may trade.'
  }
  const actions = Number(form.maxActionsPerTick.trim())
  if (!Number.isInteger(actions) || actions < 1 || actions > 5) {
    return 'Actions per check: write a whole number from 1 to 5.'
  }
  return { ...before, instructions, tokens, maxActionsPerTick: actions }
}

/** A tick's outcome, said plainly. */
export const OUTCOMES: Record<string, string> = {
  acted: 'Traded',
  held: 'Held',
  skipped: 'Skipped',
  error: 'Error',
  refused: 'Refused',
}

export const PAUSED_BY: Record<string, string> = {
  owner: 'by you',
  kill: 'by Stop everything',
  agent_paused: 'because the agent is paused',
  errors: 'after 3 API errors in a row',
  refusals: 'after 3 refused checks in a row',
}

/** Thousands separated, for token counts. */
export const count = (n: number) => n.toLocaleString('en-US')

/** A signed amount of the chain's dollar, atomic: "-$1.25" or "+$3.00". */
export function signedUsd(amount: string, format: (atomic: string) => string): string {
  const negative = amount.startsWith('-')
  const value = negative ? amount.slice(1) : amount
  return `${negative ? '-' : value === '0' ? '' : '+'}${format(value)}`
}
