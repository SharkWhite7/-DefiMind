import { dollarsInput, parseDollars } from './money.js'

/** CR-026, per mint: each field absent means the agent's own default. */
export interface TokenLimit {
  maxBuyUsd?: string | undefined
  maxHeldUsd?: string | undefined
}

export const KINDS = ['buy', 'sell', 'swap'] as const
export type Kind = (typeof KINDS)[number]

export interface OperationLimit {
  maxTradeUsd: string
  dailyMax: string
}

/** CR-026's and CR-028's additions to Policy.trading. */
export interface Limits {
  tokenLimits?: Record<string, TokenLimit> | undefined
  operations?: Partial<Record<Kind, OperationLimit>> | undefined
  orders?: { enabled: boolean; maxOpen: number } | undefined
  rugShield?: { enabled: boolean } | undefined
  quickFirstBuy?: { maxUsd: string; dailyUsd: string } | undefined
}

const ORDERS = { enabled: false, maxOpen: 10 }

/**
 * A field changed in a way SPEC counts as loosening: added, raised, or removed (its default may be
 * wider: a sell without a limit is not capped at all).
 */
function wider(before: string | undefined, after: string | undefined): boolean {
  if (before === after) {
    return false
  }
  return before === undefined || after === undefined || BigInt(after) > BigInt(before)
}

/** Whether CR-026's limits loosen: any of them added, raised or removed, or orders opened up. */
export function limitsLoosen(before: Limits, after: Limits): boolean {
  const mints = new Set([
    ...Object.keys(before.tokenLimits ?? {}),
    ...Object.keys(after.tokenLimits ?? {}),
  ])
  const tokens = [...mints].some((mint) => {
    const was = before.tokenLimits?.[mint]
    const now = after.tokenLimits?.[mint]
    return wider(was?.maxBuyUsd, now?.maxBuyUsd) || wider(was?.maxHeldUsd, now?.maxHeldUsd)
  })
  const operations = KINDS.some((kind) => {
    const was = before.operations?.[kind]
    const now = after.operations?.[kind]
    return wider(was?.maxTradeUsd, now?.maxTradeUsd) || wider(was?.dailyMax, now?.dailyMax)
  })
  const was = before.orders ?? ORDERS
  const now = after.orders ?? ORDERS
  const shieldOff = (before.rugShield?.enabled ?? true) && !(after.rugShield?.enabled ?? true)
  const quick =
    after.quickFirstBuy !== undefined &&
    (before.quickFirstBuy === undefined ||
      BigInt(after.quickFirstBuy.maxUsd) > BigInt(before.quickFirstBuy.maxUsd) ||
      BigInt(after.quickFirstBuy.dailyUsd) > BigInt(before.quickFirstBuy.dailyUsd))
  return (
    tokens ||
    operations ||
    (now.enabled && !was.enabled) ||
    now.maxOpen > was.maxOpen ||
    shieldOff ||
    quick
  )
}

/** The limits as the owner types them: dollars, an empty field for the default. */
export interface LimitsForm {
  tokens: Record<string, { maxBuy: string; maxHeld: string }>
  operations: Record<Kind, { trade: string; daily: string }>
  ordersEnabled: boolean
  maxOpen: string
  shield: boolean
  quickBuy: string
  quickDay: string
}

const shown = (amount: string | undefined) => (amount === undefined ? '' : dollarsInput(amount))

/**
 * Every mint with a limit, allowed or not, then the allowed ones without: a limit on a mint the
 * owner no longer lists stays visible, so saving never drops it unseen.
 */
export function limitedMints(limits: Limits, allowed: string[]): string[] {
  return [...new Set([...allowed, ...Object.keys(limits.tokenLimits ?? {})])]
}

export function toLimitsForm(limits: Limits, mints: string[]): LimitsForm {
  const op = (kind: Kind) => limits.operations?.[kind]
  return {
    tokens: Object.fromEntries(
      mints.map((mint) => {
        const limit = limits.tokenLimits?.[mint]
        return [mint, { maxBuy: shown(limit?.maxBuyUsd), maxHeld: shown(limit?.maxHeldUsd) }]
      }),
    ),
    operations: Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        { trade: shown(op(kind)?.maxTradeUsd), daily: shown(op(kind)?.dailyMax) },
      ]),
    ) as LimitsForm['operations'],
    ordersEnabled: (limits.orders ?? ORDERS).enabled,
    maxOpen: String((limits.orders ?? ORDERS).maxOpen),
    shield: limits.rugShield?.enabled ?? true,
    quickBuy: shown(limits.quickFirstBuy?.maxUsd),
    quickDay: shown(limits.quickFirstBuy?.dailyUsd),
  }
}

export const KIND_NAMES: Record<Kind, string> = { buy: 'Buys', sell: 'Sells', swap: 'Swaps' }

/** An empty field is the default; anything else must be dollars. */
function amount(text: string): string | undefined | false {
  const trimmed = text.trim()
  return trimmed === '' ? undefined : (parseDollars(trimmed) ?? false)
}

/** The limits after the form, or the first thing wrong with it, said to the owner. */
export function fromLimitsForm(form: LimitsForm): Limits | string {
  const tokenLimits: Record<string, TokenLimit> = {}
  for (const [mint, { maxBuy, maxHeld }] of Object.entries(form.tokens)) {
    const buy = amount(maxBuy)
    const held = amount(maxHeld)
    if (buy === false || held === false) {
      return `${mint}: write an amount in dollars, like 5.00, or leave it empty.`
    }
    if (buy !== undefined || held !== undefined) {
      tokenLimits[mint] = {
        ...(buy === undefined ? {} : { maxBuyUsd: buy }),
        ...(held === undefined ? {} : { maxHeldUsd: held }),
      }
    }
  }
  const operations: Partial<Record<Kind, OperationLimit>> = {}
  for (const kind of KINDS) {
    const trade = amount(form.operations[kind].trade)
    const daily = amount(form.operations[kind].daily)
    if (trade === false || daily === false) {
      return `${KIND_NAMES[kind]}: write an amount in dollars, like 5.00, or leave it empty.`
    }
    if ((trade === undefined) !== (daily === undefined)) {
      return `${KIND_NAMES[kind]}: write both, per trade and per day, or leave both empty.`
    }
    if (trade !== undefined && daily !== undefined) {
      operations[kind] = { maxTradeUsd: trade, dailyMax: daily }
    }
  }
  const open = form.maxOpen.trim()
  if (!/^\d{1,6}$/.test(open)) {
    return 'Open orders: write a whole number, like 10.'
  }
  const maxOpen = Number(open)
  const quickBuy = amount(form.quickBuy)
  const quickDay = amount(form.quickDay)
  if (
    quickBuy === false ||
    quickDay === false ||
    (quickBuy === undefined) !== (quickDay === undefined)
  ) {
    return 'Quick first buys: write both amounts in dollars, or leave both empty to turn them off.'
  }
  return {
    ...(Object.keys(tokenLimits).length === 0 ? {} : { tokenLimits }),
    ...(Object.keys(operations).length === 0 ? {} : { operations }),
    orders: { enabled: form.ordersEnabled, maxOpen },
    // Absent means on, so only an off shield is written down.
    ...(form.shield ? {} : { rugShield: { enabled: false } }),
    ...(quickBuy === undefined || quickDay === undefined
      ? {}
      : { quickFirstBuy: { maxUsd: quickBuy, dailyUsd: quickDay } }),
  }
}

/** The trading policy with these limits in place of the old ones: one left empty is removed. */
export function withLimits<T extends Limits>(trading: T, limits: Limits): T {
  const rest = { ...trading }
  delete rest.tokenLimits
  delete rest.operations
  delete rest.orders
  delete rest.rugShield
  delete rest.quickFirstBuy
  return { ...rest, ...limits }
}
