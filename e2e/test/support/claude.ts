import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A scripted stand-in for POST /v1/messages (INT-52, CR-027). Each request takes the next turn of
 * the script, so a test reads as the conversation it expects. guard-core reaches it through
 * ANTHROPIC_BASE_URL; nothing here talks to Anthropic.
 */
export type Turn =
  | { tools: { name: string; input: Record<string, unknown> }[]; text?: string }
  | { text: string }
  | { refusal: true }
  | { maxTokens: true }
  | { status: number; error?: string }

export interface Recorded {
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

const usage = {
  input_tokens: 1200,
  output_tokens: 150,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 1000,
}

let ids = 0
const message = (model: string, content: unknown[], stopReason: string) => ({
  id: `msg_mock_${++ids}`,
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  stop_details:
    stopReason === 'refusal' ? { type: 'refusal', category: null, explanation: null } : null,
  usage,
})

function reply(turn: Turn | undefined, model: string): { status: number; body: unknown } {
  if (turn === undefined)
    return { status: 200, body: message(model, [{ type: 'text', text: 'Holding.' }], 'end_turn') }
  if ('status' in turn) {
    const type =
      turn.status === 429
        ? 'rate_limit_error'
        : turn.status >= 500
          ? 'api_error'
          : 'invalid_request_error'
    return {
      status: turn.status,
      body: { type: 'error', error: { type, message: turn.error ?? 'mock error' } },
    }
  }
  if ('refusal' in turn) return { status: 200, body: message(model, [], 'refusal') }
  if ('maxTokens' in turn)
    return { status: 200, body: message(model, [{ type: 'text', text: 'I will' }], 'max_tokens') }
  if ('tools' in turn) {
    const calls = turn.tools.map(({ name, input }) => ({
      type: 'tool_use',
      id: `toolu_mock_${++ids}`,
      name,
      input,
    }))
    const text = turn.text === undefined ? [] : [{ type: 'text', text: turn.text }]
    return { status: 200, body: message(model, [...text, ...calls], 'tool_use') }
  }
  return { status: 200, body: message(model, [{ type: 'text', text: turn.text }], 'end_turn') }
}

export async function mockClaude(script: Turn[] = []) {
  const requests: Recorded[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
        res.writeHead(404).end()
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      requests.push({ headers: req.headers, body })
      const out = reply(script.shift(), String(body['model']))
      // The SDK retries 429 and 5xx; tell it not to, so one scripted error is one error.
      res.writeHead(out.status, { 'content-type': 'application/json', 'x-should-retry': 'false' })
      res.end(JSON.stringify(out.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Queue more turns, e.g. for the next tick. */
    push: (...turns: Turn[]) => script.push(...turns),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Every tool_result block the trader sent back in one request, as text. */
export function toolResults(request: Recorded): string[] {
  const messages = (request.body['messages'] ?? []) as { role: string; content: unknown }[]
  return messages.flatMap(({ content }) =>
    Array.isArray(content)
      ? content
          .filter(
            (b): b is { type: 'tool_result'; content: unknown } =>
              (b as { type?: string }).type === 'tool_result',
          )
          .map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)))
      : [],
  )
}
