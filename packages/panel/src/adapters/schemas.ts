import { z } from 'zod'

/**
 * guard-core's owner responses. Same-origin and behind a session, but the strings inside started
 * with an agent or a 402 server, so they are bounded here and only ever set as text.
 */

const atomic = z.string().regex(/^(0|[1-9]\d*)$/)
const isoTime = z.iso.datetime({ offset: true })
const text = (max: number) => z.string().max(max)
const agentId = z.string().min(1).max(64)

export const allowance = z
  .discriminatedUnion('status', [
    z.object({ status: z.literal('active'), cap: atomic, spent: atomic, resetsAt: isoTime }),
    z.object({ status: z.literal('none') }),
  ])
  .nullable()

export const agentSummary = z.object({
  agentId,
  paused: z.boolean(),
  mode: z.enum(['live', 'shadow']),
})

export const intent = z.object({
  id: z.uuid(),
  agentId,
  kind: z.enum(['x402', 'transfer']),
  chain: text(64),
  token: text(128),
  amount: text(78),
  recipient: text(128),
  domain: text(253).optional(),
  reason: text(500),
  status: text(32),
  expiresAt: isoTime,
})

export const approvalRequest = z.object({
  intent,
  simulation: z.object({ summary: text(1000) }),
  approveBefore: isoTime,
  flags: z.array(text(64)).max(8).default([]),
  pinned: z.object({ recipient: text(128), amount: atomic }).optional(),
})

export const mandate = z.object({
  id: z.uuid(),
  agentId,
  budget: atomic,
  spent: atomic,
  domains: z.array(text(253)).max(64),
  recipients: z.array(text(128)).max(64),
  reason: text(500),
  status: text(32),
  expiresAt: isoTime,
})

export const mandateRequest = z.object({
  mandate,
  approveBefore: isoTime,
  ttlSeconds: z.number().int().positive().optional(),
})

export const overview = z.object({
  chains: z.array(z.object({ chain: text(64), allowance })).max(16),
  agents: z.array(agentSummary).max(1000),
  pending: z.array(approvalRequest).max(500),
  mandates: z.array(mandateRequest).max(500),
})

export const policy = z.object({
  agentId,
  chains: z.array(text(64)).max(16),
  tokens: z.array(text(128)).max(32),
  perTxMax: atomic,
  dailyMax: atomic,
  approvalThreshold: atomic,
  allowedRecipients: z.array(text(128)).max(256),
  allowedDomains: z.array(text(253)).max(256),
  paused: z.boolean(),
  mode: z.enum(['live', 'shadow']).optional(),
  priceIncreaseMaxPct: z.number().optional(),
  maxPaymentsPerMinute: z.number().optional(),
  requireMandate: z.boolean().optional(),
})

export const budget = z.object({
  spentToday: atomic,
  dailyMax: atomic,
  perTxMax: atomic,
  paused: z.boolean(),
  shadowSpentToday: atomic.optional(),
  shadow: z.object({ since: isoTime, total: atomic, count: z.number().int() }).optional(),
})

export const report = z.object({
  agents: z
    .array(
      z.object({
        agentId,
        spent: atomic,
        payments: z.number().int().nonnegative(),
        refused: z.record(text(64), z.number().int().nonnegative()),
        domains: z.array(z.object({ domain: text(253), spent: atomic })).max(500),
      }),
    )
    .max(1000),
})

export const doctor = z.object({
  checks: z
    .array(
      z.object({
        id: text(64),
        status: z.enum(['ok', 'warn', 'fail']),
        message: text(500),
        fix: text(500).optional(),
      }),
    )
    .max(64),
})

export const passkeys = z.object({
  passkeys: z
    .array(z.object({ id: text(256), createdAt: isoTime, lastUsedAt: isoTime.nullish() }))
    .max(64),
})

const https = z.url({ protocol: /^https$/ })

/**
 * payload is the transaction the owner signs, null when guard-core could not build it. link (the
 * Phantom app) and pageLink (the signing page on a desktop) are not in SPEC yet: shown when present.
 */
export const kill = z.object({
  pausedAgents: z.number().int().nonnegative(),
  ownerTransactions: z
    .array(
      z.object({
        chain: text(64),
        description: text(2000),
        payload: z.unknown(),
        link: https.optional(),
        pageLink: https.optional(),
      }),
    )
    .max(16),
})

export const agents = z.object({ agents: z.array(agentSummary).max(1000) })
const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`))
const seq = z.number().int().positive()

/**
 * CR-013. Loose objects: a proof bundle is downloaded as guard-core sent it, and a field this panel
 * does not know yet still counts in the receipt's hash.
 */
export const receipt = z.looseObject({
  seq,
  agentId,
  kind: z.enum(['tool_call', 'payment']),
  server: text(128),
  tool: text(128),
  outcome: z.enum(['ok', 'error', 'refused']),
  assurance: z.enum(['executed', 'relayed']),
  startedAt: isoTime,
  endedAt: isoTime,
  hash: hex(64),
})

export const anchor = z.looseObject({
  fromSeq: seq,
  toSeq: seq,
  root: hex(64),
  chain: text(64),
  txId: text(128),
  anchoredAt: isoTime,
})

export const executions = z.object({ receipts: z.array(receipt).max(10_000) })

export const integrity = z.object({
  lastSeq: z.number().int().nonnegative(),
  lastHash: text(64),
  brokenAt: seq.optional(),
  lastAnchor: anchor.optional(),
})

export const proof = z.looseObject({
  receipt,
  siblings: z.array(z.object({ side: z.enum(['left', 'right']), hash: hex(64) })).max(64),
  anchor,
})

export const created = z.object({ agentId, token: z.string().min(16).max(512) })
export const session = z.object({ expiresAt: isoTime })
export const pushKey = z.object({ publicKey: z.string().regex(/^[A-Za-z0-9_-]+$/) })
export const pushId = z.object({ id: text(128) })
export const problem = z.object({ error: text(64) })

export type Overview = z.infer<typeof overview>
export type ApprovalView = z.infer<typeof approvalRequest>
export type MandateView = z.infer<typeof mandateRequest>
export type AgentView = z.infer<typeof agentSummary>
export type PolicyView = z.infer<typeof policy>
export type BudgetView = z.infer<typeof budget>
export type KillView = z.infer<typeof kill>
export type ReceiptView = z.infer<typeof receipt>
export type IntegrityView = z.infer<typeof integrity>
