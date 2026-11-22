import Anthropic from '@anthropic-ai/sdk'
import { costMicros } from '../pricing.js'
import type { Conversation, Reply, ToolResult } from './types.js'
import { ProviderAbort, ProviderError } from './types.js'

const MAX_TOKENS = 64_000
const TASK_BUDGET_TOKENS = 200_000

/**
 * What each model accepts beyond the basics. Haiku 5.5 rejects server-side fallbacks with a 400 and has no
 * progress-update thinking display; Opus 5.5 and Sonnet 5.5 support both.
 */
export function modelFeatures(model: string): { progressUpdates: boolean; fallbacks: boolean } {
  if (model.startsWith('claude-haiku')) return { progressUpdates: false, fallbacks: false }
  return { progressUpdates: true, fallbacks: true }
}

function translate(error: unknown): unknown {
  if (error instanceof Anthropic.APIUserAbortError) return new ProviderAbort('Cancelled')
  if (!(error instanceof Anthropic.APIError)) return error
  if (error instanceof Anthropic.AuthenticationError) return new ProviderError('auth', 'anthropic', 401, 'The Anthropic API key was rejected. Update it in agent settings.')
  if (error instanceof Anthropic.PermissionDeniedError) return new ProviderError('permission', 'anthropic', 403, 'The Anthropic API key is not allowed to use this model.')
  if (error instanceof Anthropic.RateLimitError) return new ProviderError('rate', 'anthropic', 429, 'The Anthropic API rate limit was reached. Try again shortly.')
  if (error instanceof Anthropic.BadRequestError) return new ProviderError('request', 'anthropic', 400, `The Claude API rejected the request: ${error.message.slice(0, 300)}`)
  return new ProviderError('other', 'anthropic', error.status, `The Claude API returned an error (${error.status ?? 'network'}).`)
}

type Setup = {
  apiKey: string
  model: string
  effort: string
  system: string
  tools: Anthropic.Beta.BetaTool[]
  baseURL?: string
  fallbacks: boolean
}

/**
 * The Claude Messages API (design §13.4): streaming, adaptive thinking, an explicit effort and task budget,
 * and a cached prefix.
 */
export class AnthropicConversation implements Conversation {
  private readonly client: Anthropic
  private readonly messages: Anthropic.Beta.BetaMessageParam[] = []
  private last: Anthropic.Beta.BetaMessage | null = null

  constructor(private readonly setup: Setup, history: Array<{ prompt: string; reply: string }>, prompt: string) {
    this.client = new Anthropic({ apiKey: setup.apiKey, baseURL: setup.baseURL, maxRetries: 2 })
    for (const past of history) {
      this.messages.push({ role: 'user', content: past.prompt }, { role: 'assistant', content: past.reply || '(no reply)' })
    }
    this.messages.push({ role: 'user', content: prompt })
  }

  async respond(signal: AbortSignal): Promise<Reply> {
    const { setup } = this
    const features = modelFeatures(setup.model)
    const fallbacks = setup.fallbacks && features.fallbacks
    for (let attempt = 0; ; attempt++) {
      try {
        const stream = this.client.beta.messages.stream(
          {
            model: setup.model,
            max_tokens: MAX_TOKENS,
            system: setup.system,
            tools: setup.tools,
            messages: this.messages,
            thinking: features.progressUpdates ? { type: 'adaptive', display: 'updates' } : { type: 'adaptive' },
            output_config: { effort: setup.effort as 'high', task_budget: { type: 'tokens', total: TASK_BUDGET_TOKENS } },
            cache_control: { type: 'ephemeral' },
            betas: [
              'task-budgets-2026-03-13',
              ...(features.progressUpdates ? (['thinking-display-updates-2026-08-18'] as const) : []),
              ...(fallbacks ? (['server-side-fallback-2026-07-01'] as const) : []),
            ],
            ...(fallbacks ? { fallbacks: 'default' as const } : {}),
          },
          { signal },
        )
        const message = await stream.finalMessage()
        this.last = message
        return this.reply(message)
      } catch (failure) {
        // Unparseable streamed tool input or a dropped connection: re-issue a few times. API errors and
        // cancellation are not retried here.
        if (failure instanceof Anthropic.APIError || signal.aborted || attempt >= 2) throw translate(failure)
      }
    }
  }

  private reply(message: Anthropic.Beta.BetaMessage): Reply {
    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    }
    const texts: string[] = []
    const notes: string[] = []
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) texts.push(block.text)
      if (block.type === 'thinking' && block.thinking.trim()) notes.push(block.thinking)
    }
    const calls = message.content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }))
    const stop: Reply['stop'] =
      message.stop_reason === 'refusal' ? 'refusal'
        : message.stop_reason === 'pause_turn' ? 'pause'
          : message.stop_reason === 'max_tokens' ? 'max_tokens'
            : calls.length > 0 ? 'tool_use' : 'end'
    return {
      model: message.model,
      usage,
      costMicros: costMicros(message.model, usage),
      texts,
      notes,
      calls,
      stop,
      refusal: message.stop_reason === 'refusal' ? (message.stop_details?.explanation ?? undefined) : undefined,
    }
  }

  keepReply() {
    if (this.last) this.messages.push({ role: 'assistant', content: this.last.content })
  }

  addResults(results: ToolResult[], guidance: string[]) {
    // Every result goes back in one user message, as the API expects for parallel calls; guidance from the
    // sponsor rides along after the results.
    this.messages.push({
      role: 'user',
      content: [
        ...results.map((r): Anthropic.Beta.BetaToolResultBlockParam => ({
          type: 'tool_result', tool_use_id: r.id, is_error: r.isError || undefined, content: r.content,
        })),
        ...guidance.map((text) => ({ type: 'text' as const, text })),
      ],
    })
  }

  addGuidance(guidance: string[]) {
    this.messages.push({ role: 'user', content: guidance.map((text) => ({ type: 'text' as const, text })) })
  }
}
