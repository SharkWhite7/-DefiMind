const LIMITS = ['perTxMax', 'dailyMax', 'approvalThreshold'] as const
const LISTS = ['chains', 'tokens', 'allowedRecipients', 'allowedDomains'] as const

/** The parts of a Policy a change can loosen. */
export type Rules = Record<(typeof LIMITS)[number], string> &
  Record<(typeof LISTS)[number], string[]> & {
    mode?: 'live' | 'shadow' | undefined
    requireMandate?: boolean | undefined
  }

/**
 * Whether a policy change loosens anything, as SPEC lists it: a raised limit, anything added to an
 * allowlist, going live, or no longer requiring a mandate. guard-core asks for a passkey then; the
 * panel asks first, so the owner is not refused after pressing Save.
 */
export function loosens(before: Rules, after: Rules): boolean {
  const raised = LIMITS.some((limit) => BigInt(after[limit]) > BigInt(before[limit]))
  const added = LISTS.some((list) => after[list].some((item) => !before[list].includes(item)))
  const live = after.mode === 'live' && (before.mode ?? 'live') !== 'live'
  const unmandated = after.requireMandate === false && before.requireMandate === true
  return raised || added || live || unmandated
}

/** Lowercase DNS labels only: an allowlist entry that is not a hostname would never match a request. */
export function hostname(text: string): string | undefined {
  const host = text.trim().toLowerCase()
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
  const labels = host.split('.')
  return host.length <= 253 && labels.length >= 2 && labels.every((part) => label.test(part))
    ? host
    : undefined
}
