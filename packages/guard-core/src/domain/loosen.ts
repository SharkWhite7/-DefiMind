import type { Policy } from '@defimind/shared'
import { parseAmount } from './amount.js'
import type { StoredPolicy } from './policy.js'

const LIMITS = ['perTxMax', 'dailyMax', 'approvalThreshold'] as const
const LISTS = ['chains', 'tokens', 'allowedRecipients', 'allowedDomains'] as const

/**
 * The fields a policy change loosens: SPEC's list (a raised limit, anything added to an allowlist,
 * going live, no longer requiring a mandate), plus three it leaves out. Unpausing here is a resume
 * without the resume's passkey, and a higher breaker or price-jump limit lets more through. Any of
 * them needs the owner's passkey; a change that only tightens needs the session alone.
 */
export function loosened(before: StoredPolicy, after: Policy): string[] {
  const raised = LIMITS.filter((limit) => parseAmount(after[limit]) > parseAmount(before[limit]))
  const added = LISTS.filter((list) => after[list].some((item) => !before[list].includes(item)))
  return [
    ...raised,
    ...added,
    ...(after.mode === 'live' && before.mode !== 'live' ? ['mode'] : []),
    ...(after.requireMandate === false && before.requireMandate ? ['requireMandate'] : []),
    ...(!after.paused && before.paused ? ['paused'] : []),
    ...((after.maxPaymentsPerMinute ?? 0) > before.maxPaymentsPerMinute
      ? ['maxPaymentsPerMinute']
      : []),
    ...((after.priceIncreaseMaxPct ?? 0) > before.priceIncreaseMaxPct
      ? ['priceIncreaseMaxPct']
      : []),
  ]
}
