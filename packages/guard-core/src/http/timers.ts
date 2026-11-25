import type { FastifyInstance } from 'fastify'
import { anchorJob, type AnchorPublisher } from '../service/anchor.js'
import { INTEGRITY_EVERY_MS } from '../service/integrity.js'
import type { X402Deps } from '../service/x402.js'
import { sweep } from '../service/sweep.js'
import type { BucketConfig } from '../adapters/bucket.js'
import { scheduleBackups } from '../service/backup.js'
import { alert } from '../service/events.js'
import { orderWatcher } from '../service/order-watcher.js'
import { rugShield, type ShieldRules } from '../service/rug-shield.js'
import type { Claude } from '../adapters/claude.js'
import { jupiterTokens } from '../adapters/jupiter-tokens.js'
import { dueTicks, samplePrices } from '../service/trader-schedule.js'
import { endInterrupted } from '../db/traders.js'

const PRICE_EVERY_MS = 15 * 60_000

/** The order watcher (CR-026): off when unset, as in tests that tick it directly. */
export type Watch = { checkMs: number; confirmChecks: number; confirmSeconds: number }

/** The AI traders (CR-027): off when unset, as in tests that run ticks directly. */
export type Traders = { checkMs: number; claude?: Claude | undefined }

/** The daily backup (CR-024): off when unset, as in tests. */
export type Backups = { databaseUrl: string; hour: number; bucket?: BucketConfig | undefined }

/** The background work: the daily chain check and backup, the anchor job and the expiry sweep. */
export function startTimers(
  first: FastifyInstance,
  deps: X402Deps,
  options: {
    anchorPublisher?: AnchorPublisher
    sweepMs?: number
    backups?: Backups
    orders?: Watch
    shield?: ShieldRules
    traders?: Traders
  },
): void {
  if (options.traders !== undefined) {
    const { checkMs, claude } = options.traders
    endInterrupted(deps.db)
    const t = {
      deps,
      search: jupiterTokens(deps.fetch),
      ...(claude === undefined ? {} : { claude }),
    }
    every(first, checkMs, () => dueTicks(t))
    every(first, PRICE_EVERY_MS, () => samplePrices(t))
  }
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
  if (options.shield !== undefined) {
    const shield = rugShield(deps, options.shield)
    let running = false
    const timer = setInterval(() => {
      if (running) {
        return
      }
      running = true
      void shield.tick().finally(() => {
        running = false
      })
    }, options.shield.checkMs)
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

/** Runs `job` on an interval, never two at once: a slow venue or API must not stack them. */
function every(first: FastifyInstance, ms: number, job: () => Promise<void>): void {
  let running = false
  const timer = setInterval(() => {
    if (running) {
      return
    }
    running = true
    job()
      .catch((error: unknown) => first.log.error({ err: error }, 'background job failed'))
      .finally(() => {
        running = false
      })
  }, ms)
  timer.unref()
  first.addHook('onClose', async () => clearInterval(timer))
}
