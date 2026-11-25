import type { Address, Amount } from './types.js'
import type { TraderTemplate } from './trader-templates.js'

/**
 * CR-029: the DefiMind Network's shapes. Nothing here can approve, buy or sell: a deployment uses
 * the Radar only to refuse a buy and the feed only to narrow its own list.
 */
export type RadarRule = 'new_risk' | 'liquidity_gone'

/** No baseline and no amounts: the network confirms every claim from the chain itself. */
export interface RadarReport {
  mint: Address
  rule: RadarRule
  /** Where the deployment saw it; within RADAR_MAX_LOOKBACK. */
  slot: number
}

/** "DefiMind Network admin v1\n" + canonical JSON of the signed fields, by ADMIN_WALLET. */
export interface AdminSignature {
  domain: string
  action: 'clear_listing' | 'remove_strategy' | 'create_proposal'
  target: string
  bodySha256: string
  reason: string
  at: string
  nonce: string
  /** base58 ed25519 signature. */
  signature: string
}

export interface RadarListing {
  mint: Address
  rule: RadarRule
  /** What the network confirmed itself, in plain words. */
  facts: string[]
  status: 'listed' | 'cleared'
  listedAt: string
  clearedAt?: string
  /** Required to clear a new_risk listing; guard-core drops a clearance that does not verify. */
  clearance?: AdminSignature
}

export interface NetworkStrategy {
  id: string
  /** Versions share one strategy's votes and its slot. */
  version: number
  /** The holder wallet that published it. */
  creator: Address
  /** At most 60 characters. */
  name: string
  /** At most 200 characters. */
  summary: string
  /** At most 2000 characters of NFKC printable text, with no address, cashtag or quoted word. */
  instructions: string
  suggested: TraderTemplate['suggested']
  /** Held weight in the token's atomic units, not a head count. */
  votes: { up: Amount; down: Amount }
  status: 'listed' | 'removed'
  publishedAt: string
}
