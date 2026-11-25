import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'

export type { BetaMessage, MessageCreateParamsNonStreaming as ClaudeRequest }

/** One non-streaming Messages call; the trader's whole view of the Claude API. */
export type Claude = (request: MessageCreateParamsNonStreaming) => Promise<BetaMessage>

/**
 * The owner's own key, held by the SDK client and nowhere else. With no `baseURL` the SDK reads
 * ANTHROPIC_BASE_URL itself, so a proxy or a test double needs no code here. Rate-limited and
 * overloaded answers are retried by the SDK before they reach the trader.
 */
export function claude(apiKey: string, options: { baseURL?: string; fetch?: typeof fetch } = {}) {
  const client = new Anthropic({ apiKey, ...options })
  const create: Claude = (request) => client.beta.messages.create(request)
  return create
}
