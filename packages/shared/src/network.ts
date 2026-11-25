import type { Address, Amount } from './types.js'
import type { TraderTemplate } from './trader-templates.js'

/**
 * CR-029: the DefiMind Network's shapes. Nothing here can approve, buy or sell: a deployment uses
 * the Radar only to refuse a buy and the feed only to narrow a list.
 */
export type RadarRule = 'new_risk' | 'liquidity_gone'

export interface RadarReport {
  mint: Address
  rule: RadarRule
  evidence: {
    slot: number
    /** The reporter's own baseline. The network confirms a supply jump from the chain, not this. */
    baseline?: {
      freezeAuthority: boolean
      mintAuthority: boolean
      extensions: string[]
      supply: Amount
    }
    observedAt: string
  }
}

export interface RadarListing {
  mint: Address
  rule: RadarRule
  /** What the network confirmed itself, in plain words. */
  facts: string[]
  status: 'listed' | 'cleared'
  listedAt: string
  clearedAt?: string
}

export interface NetworkStrategy {
  id: string
  version: number
  /** The holder wallet that published it. */
  creator: Address
  /** At most 60 characters. */
  name: string
  /** At most 200 characters. */
  summary: string
  /** At most 2000 characters; the network refuses any mint or address in it. */
  instructions: string
  suggested: TraderTemplate['suggested']
  /** Held weight in the token's atomic units, not a head count. */
  votes: { up: Amount; down: Amount }
  status: 'listed' | 'removed'
  publishedAt: string
}
