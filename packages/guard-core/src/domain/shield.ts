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

/** One position's run of shield checks, kept in memory. */
export interface Watch {
  /** The new risk the previous check saw, which this one must see again to fire. */
  risk?: string
  /** The last quote within the impact limit: the liquidity rule needs one before it can fire. */
  lastGood?: bigint
  /** Consecutive checks since then with no route, or above the limit. */
  bad: number
}

/** The liquidity rule's floor: the fresh quote less slippage, never under the last good one less the most loss. */
export function shieldFloor(
  fresh: bigint,
  slippageBps: number,
  lastGood: bigint | undefined,
  maxLossBps: number,
): bigint {
  const market = (fresh * (BPS - BigInt(slippageBps))) / BPS
  const least = lastGood === undefined ? 0n : (lastGood * (BPS - BigInt(maxLossBps))) / BPS
  return market > least ? market : least
}
