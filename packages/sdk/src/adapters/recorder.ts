import type { ExecutionReceipt } from '@defimind/shared'
import { executionReceipt } from '../domain/schemas.js'

/** The body of POST /v1/agent/executions: hashes and times, never the call's content. */
export interface ExecutionReport {
  server: string
  tool: string
  requestHash: string
  responseHash: string
  outcome: ExecutionReceipt['outcome']
  startedAt: string
  endedAt: string
}

export interface Recorder {
  record(report: ExecutionReport): Promise<ExecutionReceipt>
}

export interface RecorderOptions {
  guardUrl: string
  token: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

/** A call that guard-core did not record. The receipt is missing, not the call's result. */
export class RecordError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message)
  }
}

export function httpRecorder(options: RecorderOptions): Recorder {
  const { token, fetch = globalThis.fetch, timeoutMs = 15_000 } = options
  const url = new URL('/v1/agent/executions', checkedUrl(options.guardUrl))
  return {
    async record(report) {
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(report),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        throw new RecordError('DefiMind could not be reached to record the call.')
      }
      if (!response.ok) {
        throw new RecordError(
          `DefiMind did not record the call (HTTP ${response.status}).`,
          response.status,
        )
      }
      const receipt = executionReceipt.safeParse(await response.json().catch(() => undefined))
      if (!receipt.success) {
        throw new RecordError('DefiMind answered with something that is not a receipt.')
      }
      return receipt.data
    },
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The token rides on every report, so plain http only where it never leaves the machine. */
function checkedUrl(value: string): URL {
  const url = new URL(value)
  if (url.username !== '' || url.password !== '') {
    throw new Error('the DefiMind URL must not carry credentials')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('the DefiMind URL must be https://, or http:// to localhost')
  }
  return url
}
