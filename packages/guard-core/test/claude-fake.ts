import { claude } from '../src/adapters/claude.js'

/**
 * The real SDK client over a scripted fetch: each request takes the next turn. Nothing leaves the
 * process, so CI never calls the Claude API.
 */
export type Turn =
  | { tools: { name: string; input: Record<string, unknown> }[]; text?: string }
  | { text: string }
  | { refusal: true; tools?: { name: string; input: Record<string, unknown> }[] }
  | { maxTokens: true; tools?: { name: string; input: Record<string, unknown> }[] }
  | { status: number }

export interface Sent {
  headers: Headers
  body: Record<string, unknown>
}

let ids = 0

const toolUses = (tools: { name: string; input: Record<string, unknown> }[] = []) =>
  tools.map(({ name, input }) => ({ type: 'tool_use', id: `toolu_${++ids}`, name, input }))

function answer(turn: Turn | undefined, model: string): { status: number; body: unknown } {
  const message = (content: unknown[], stop: string) => ({
    id: `msg_${++ids}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2000,
    },
  })
  if (turn === undefined) {
    return { status: 200, body: message([{ type: 'text', text: 'Holding.' }], 'end_turn') }
  }
  if ('status' in turn) {
    const error = { type: 'api_error', message: 'scripted' }
    return { status: turn.status, body: { type: 'error', error } }
  }
  if ('refusal' in turn) {
    return { status: 200, body: message(toolUses(turn.tools), 'refusal') }
  }
  if ('maxTokens' in turn) {
    return { status: 200, body: message(toolUses(turn.tools), 'max_tokens') }
  }
  if ('tools' in turn) {
    const text = turn.text === undefined ? [] : [{ type: 'text', text: turn.text }]
    return { status: 200, body: message([...text, ...toolUses(turn.tools)], 'tool_use') }
  }
  return { status: 200, body: message([{ type: 'text', text: turn.text }], 'end_turn') }
}

export function fakeClaude(script: Turn[] = []) {
  const sent: Sent[] = []
  /** Runs before each answer, with the request's index: what the owner does between turns. */
  const hooks: { before?: (request: number) => void } = {}
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    sent.push({ headers: new Headers(init?.headers), body })
    hooks.before?.(sent.length - 1)
    const out = answer(script.shift(), String(body['model']))
    // One scripted error is one error: the SDK would otherwise retry it.
    const headers = { 'content-type': 'application/json', 'x-should-retry': 'false' }
    return new Response(JSON.stringify(out.body), { status: out.status, headers })
  }
  return {
    claude: claude('sk-ant-test', {
      baseURL: 'http://claude.test',
      fetch: fetch as typeof globalThis.fetch,
    }),
    sent,
    hooks,
    push: (...turns: Turn[]) => script.push(...turns),
  }
}
