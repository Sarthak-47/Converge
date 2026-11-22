import type { Usage } from '../pricing.js'

/** Whose API a turn runs on; the sponsor brings their own key for it (design §13.5). */
export type Provider = 'anthropic' | 'openai' | 'gemini' | 'openrouter'

export const PROVIDER_NAMES: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
}

export type ToolCall = { id: string; name: string; input: unknown }

/** One model response, the same shape whichever provider produced it. */
export type Reply = {
  model: string
  usage: Usage
  /** Set when the provider reports the response's price itself (OpenRouter does). */
  costMicros?: number
  texts: string[]
  /** Progress the model shared while thinking, shown in the lane. */
  notes: string[]
  calls: ToolCall[]
  stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause'
  refusal?: string
}

export type ToolResult = { id: string; content: string; isError: boolean }

/** A turn's conversation with one provider: it owns the provider's message format. */
export interface Conversation {
  /** Asks for the next response; retries a broken stream itself, never an API error. */
  respond(signal: AbortSignal): Promise<Reply>
  /** Keeps the last response in the conversation. */
  keepReply(): void
  /** Answers the last response's tool calls, with any guidance from the sponsor after them. */
  addResults(results: ToolResult[], guidance: string[]): void
  /** Guidance that arrived as the model finished, so the turn goes on. */
  addGuidance(guidance: string[]): void
}

export type ProviderErrorKind = 'auth' | 'permission' | 'rate' | 'request' | 'other'

/** A provider refused a request; the message is safe to show and never includes the key. */
export class ProviderError extends Error {
  constructor(readonly kind: ProviderErrorKind, readonly provider: Provider, readonly status: number | undefined, message: string) {
    super(message)
  }
}

export class ProviderAbort extends Error {}
