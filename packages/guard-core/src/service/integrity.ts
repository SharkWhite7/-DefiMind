import type { KeyObject } from 'node:crypto'
import { alert } from './events.js'
import { checkChain, type Integrity } from './executions.js'
import type { PaymentDeps } from './payments.js'

export const INTEGRITY_EVERY_MS = 86_400_000

/**
 * Re-checks the execution chain at start-up and once a day (CR-013). A break is told to the owner
 * once, through the bot and the panel, not again on every check that finds the same one.
 */
export function integrityMonitor(deps: PaymentDeps, key: KeyObject) {
  let current: Integrity = { lastSeq: 0, lastHash: '' }
  return {
    check(): Integrity {
      const before = current.brokenAt
      current = checkChain(deps.db, key)
      if (current.brokenAt !== undefined && current.brokenAt !== before) {
        deps.log.error({ brokenAt: current.brokenAt }, 'execution chain broken')
        alert(deps, { kind: 'chain_broken', detail: `seq ${current.brokenAt}` })
      }
      return current
    },
    current: () => current,
  }
}

export type IntegrityMonitor = ReturnType<typeof integrityMonitor>
