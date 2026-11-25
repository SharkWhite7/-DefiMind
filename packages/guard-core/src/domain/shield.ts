import type { Amount } from '@defimind/shared'
import { parseAmount } from './amount.js'

const BPS = 10_000n

/** What the rug shield compares (CR-028): the mint's authorities, extensions and supply. */
export interface MintFacts {
  freezeAuthority: boolean
  mintAuthority: boolean
  extensions: string[]
  supply: Amount
}

/**
 * The risk that appeared since the baseline, in plain words, or undefined. A risk the token always
 * had is never one: the owner bought it knowing. Supply is compared with the baseline, not the last
 * check, so slow inflation adds up.
 */
export function newRisk(
  base: MintFacts,
  now: MintFacts,
  supplyJumpBps: number,
): string | undefined {
  if (now.freezeAuthority && !base.freezeAuthority) {
    return 'the mint gained a freeze authority'
  }
  const added = now.extensions.filter((extension) => !base.extensions.includes(extension))
  if (added.length > 0) {
    return `the mint gained ${added.join(', ')}`
  }
  const supply = parseAmount(now.supply)
  if (
    now.mintAuthority &&
    supply * BPS > parseAmount(base.supply) * (BPS + BigInt(supplyJumpBps))
  ) {
    return 'the supply was inflated'
  }
  return undefined
}

/** A quote within the impact limit: what `amount` of the token fetched then. */
export interface Good {
  out: bigint
  amount: bigint
}

/** One position's run of shield checks, kept in memory. */
export interface Watch {
  /** The new risk the previous check saw, which this one must see again to fire. */
  risk?: string
  /** The latest quotes within the impact limit, at most a run of them. */
  goods: Good[]
  /** Consecutive checks since the last good one with no route, or above the limit. */
  bad: number
}

/**
 * What the position held now fetched at its worst recent good quote, scaled to the amount held now.
 * The lowest of a run, so one pumped check cannot pin it high.
 */
export function reference(goods: Good[], amount: bigint): bigint | undefined {
  const scaled = goods.filter((g) => g.amount > 0n).map((g) => (g.out * amount) / g.amount)
  return scaled.length === 0 ? undefined : scaled.reduce((low, v) => (v < low ? v : low))
}

/** A shield sell's floor: the fresh quote less slippage, never under the reference less the most loss. */
export function shieldFloor(
  fresh: bigint,
  slippageBps: number,
  ref: bigint | undefined,
  maxLossBps: number,
): bigint {
  const market = (fresh * (BPS - BigInt(slippageBps))) / BPS
  const least = ref === undefined ? 0n : (ref * (BPS - BigInt(maxLossBps))) / BPS
  return market > least ? market : least
}
