import type { FastifyInstance } from 'fastify'
import { anchorJob, type AnchorPublisher } from '../service/anchor.js'
import { INTEGRITY_EVERY_MS } from '../service/integrity.js'
import type { PaymentDeps } from '../service/payments.js'
import { sweep } from '../service/sweep.js'
import type { BucketConfig } from '../adapters/bucket.js'
import { scheduleBackups } from '../service/backup.js'
import { alert } from '../service/events.js'
import { orderWatcher } from '../service/order-watcher.js'

/** The order watcher (CR-026): off when unset, as in tests that tick it directly. */
export type Watch = { checkMs: number; confirmChecks: number; confirmSeconds: number }

/** The daily backup (CR-024): off when unset, as in tests. */
export type Backups = { databaseUrl: string; hour: number; bucket?: BucketConfig | undefined }

/** The background work: the daily chain check and backup, the anchor job and the expiry sweep. */
export function startTimers(
  first: FastifyInstance,
  deps: PaymentDeps,
  options: {
    anchorPublisher?: AnchorPublisher
    sweepMs?: number
    backups?: Backups
    orders?: Watch
  },
): void {
  if (options.orders !== undefined) {
    const { checkMs } = options.orders
    const watcher = orderWatcher(deps, options.orders)
    // One tick at a time: a slow venue must not stack checks of the same order.
    let running = false
    const timer = setInterval(() => {
      if (running) {
        return
      }
      running = true
      void watcher.tick().finally(() => {
        running = false
      })
    }, checkMs)
    timer.unref()
    first.addHook('onClose', async () => clearInterval(timer))
  }
  if (options.backups !== undefined) {
    const { databaseUrl, hour, bucket } = options.backups
    const failed = (what: 'backup' | 'upload') =>
      alert(deps, {
        kind: 'backup_failed',
        detail:
          what === 'upload'
            ? "today's database backup was made but could not be uploaded to the bucket"
            : "today's database backup failed",
      })
    const backups = scheduleBackups(
      { db: deps.db, databaseUrl, now: deps.now, log: first.log, fetch, bucket, failed },
      hour,
    )
    first.addHook('onClose', async () => backups.stop())
  }
  if (deps.integrity !== undefined) {
    const { integrity } = deps
    integrity.check()
    const daily = setInterval(() => integrity.check(), INTEGRITY_EVERY_MS)
    daily.unref()
    first.addHook('onClose', async () => clearInterval(daily))
  }
  if (options.anchorPublisher !== undefined && deps.receiptKey !== undefined) {
    const anchors = anchorJob({
      db: deps.db,
      publisher: options.anchorPublisher,
      now: deps.now,
      log: first.log,
    })
    // Every minute: the job itself decides when an hour or 1,000 receipts have come.
    const minutely = setInterval(() => void anchors.tick(), 60_000)
    minutely.unref()
    first.addHook('onClose', async () => clearInterval(minutely))
  }
  if (options.sweepMs !== undefined) {
    const timer = setInterval(() => {
      const expired = sweep(deps)
      if (expired > 0) {
        first.log.info({ expired }, 'expired pending intents')
      }
    }, options.sweepMs)
    first.addHook('onClose', async () => clearInterval(timer))
  }
}
