import type Anthropic from '@anthropic-ai/sdk'
import { costMicros, type Usage } from '../pricing.js'
import type { Conversation, Provider, Reply, ToolCall, ToolResult } from './types.js'
import { PROVIDER_NAMES, ProviderAbort, ProviderError } from './types.js'

/**
 * Where each provider's OpenAI-compatible Chat Completions endpoint lives. Gemini serves one beside its own
 * API, and OpenRouter fronts hundreds of models (Llama, Mistral, DeepSeek, Qwen…) behind one.
 */
export const BASE_URLS: Record<Exclude<Provider, 'anthropic'>, string> = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openrouter: 'https://openrouter.ai/api/v1',
}

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string }

type Chunk = {
  model?: string
  choices?: Array<{
    delta?: {
      content?: string | null
      refusal?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    /** OpenRouter's own price for the request, in dollars. */
    cost?: number
  } | null
  error?: { message?: string; code?: number | string }
}

/** Gemini's function declarations reject JSON Schema keywords outside its subset, such as additionalProperties. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema)
  if (schema === null || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue
    out[key] = geminiSchema(value)
  }
  return out
}

/** A conservative token count (about three characters a token) for providers that report no usage. */
const estimate = (characters: number) => Math.ceil(characters / 3)

type Setup = {
  provider: Exclude<Provider, 'anthropic'>
  apiKey: string
  model: string
  system: string
  tools: Anthropic.Beta.BetaTool[]
  /** Overrides the provider's endpoint; tests point it at the scripted fake model. */
  baseURL?: string
}

/**
 * A turn on any provider that speaks the OpenAI Chat Completions API with tool calling: OpenAI itself,
 * Gemini and OpenRouter. Streams, so a long response never meets a request timeout. Effort and thinking
 * settings are Claude-specific and are left at the provider's defaults.
 */
export class OpenAiCompatibleConversation implements Conversation {
  private readonly messages: Message[] = []
  private readonly tools: unknown[]
  private last: Message | null = null
  private readonly name: string

  constructor(private readonly setup: Setup, history: Array<{ prompt: string; reply: string }>, prompt: string) {
    this.name = PROVIDER_NAMES[setup.provider]
    this.messages.push({ role: 'system', content: setup.system })
    for (const past of history) {
      this.messages.push({ role: 'user', content: past.prompt }, { role: 'assistant', content: past.reply || '(no reply)' })
    }
    this.messages.push({ role: 'user', content: prompt })
    this.tools = setup.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: setup.provider === 'gemini' ? geminiSchema(tool.input_schema) : tool.input_schema,
      },
    }))
  }

  async respond(signal: AbortSignal): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(signal)
      } catch (failure) {
        if (signal.aborted) throw new ProviderAbort('Cancelled')
        // A dropped connection or a garbled stream is re-issued a few times; a refusal from the API is not.
        if (failure instanceof ProviderError || attempt >= 2) {
          if (failure instanceof ProviderError) throw failure
          throw new ProviderError('other', this.setup.provider, undefined, `The ${this.name} API could not be reached.`)
        }
      }
    }
  }

  private async request(signal: AbortSignal): Promise<Reply> {
    const { setup } = this
    const body = {
      model: setup.model,
      messages: this.messages,
      tools: this.tools,
      stream: true,
      stream_options: { include_usage: true },
      ...(setup.provider === 'openrouter' ? { usage: { include: true } } : {}),
    }
    const payload = JSON.stringify(body)
    const response = await fetch(`${(setup.baseURL ?? BASE_URLS[setup.provider]).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${setup.apiKey}`,
        ...(setup.provider === 'openrouter' ? { 'X-Title': 'Converge' } : {}),
      },
      body: payload,
      signal,
    })
    if (!response.ok) throw await this.failure(response)
    if (!response.body) throw new Error('Empty response')

    let model = setup.model
    let text = ''
    let refusal = ''
    let reasoning = ''
    let finish = null as string | null
    let usage = null as Chunk['usage']
    const calls = new Map<number, { id: string; name: string; args: string }>()
    const decoder = new TextDecoder()
    let buffer = ''
    let done = false as boolean
    const handle = (line: string) => {
      if (!line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        done = true
        return
      }
      const chunk = JSON.parse(data) as Chunk
      if (chunk.error) throw new ProviderError('other', setup.provider, undefined, `The ${this.name} API stopped: ${String(chunk.error.message ?? 'error').slice(0, 300)}`)
      if (chunk.model) model = chunk.model
      if (chunk.usage) usage = chunk.usage
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {}
        if (delta.content) text += delta.content
        if (delta.refusal) refusal += delta.refusal
        if (delta.reasoning) reasoning += delta.reasoning
        if (delta.reasoning_content) reasoning += delta.reasoning_content
        for (const [position, call] of (delta.tool_calls ?? []).entries()) {
          const index = call.index ?? position
          const entry = calls.get(index) ?? { id: '', name: '', args: '' }
          if (call.id) entry.id = call.id
          if (call.function?.name) entry.name += call.function.name
          if (call.function?.arguments) entry.args += call.function.arguments
          calls.set(index, entry)
        }
        if (choice.finish_reason) finish = choice.finish_reason
      }
    }
    for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(piece, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        handle(buffer.slice(0, newline).trim())
        buffer = buffer.slice(newline + 1)
      }
    }
    if (buffer.trim()) handle(buffer.trim())
    if (!done && finish === null) throw new Error('The stream ended early')

    const toolCalls: ToolCall[] = []
    const wire: NonNullable<Extract<Message, { role: 'assistant' }>['tool_calls']> = []
    for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      const id = call.id || `call_${index}_${Date.now().toString(36)}`
      let input: unknown
      try {
        input = call.args.trim() ? JSON.parse(call.args) : {}
      } catch {
        // Handed to the tool as-is: its schema check answers INVALID_JSON and the model can retry.
        input = call.args
      }
      toolCalls.push({ id, name: call.name, input })
      wire.push({ id, type: 'function', function: { name: call.name, arguments: call.args || '{}' } })
    }
    this.last = { role: 'assistant', content: text || null, ...(wire.length > 0 ? { tool_calls: wire } : {}) }

    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0
    const counted: Usage = usage?.prompt_tokens !== undefined
      ? {
        inputTokens: Math.max(0, usage.prompt_tokens - cached),
        outputTokens: usage.completion_tokens ?? estimate(text.length + reasoning.length + JSON.stringify(wire).length),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      }
      : {
        inputTokens: estimate(payload.length),
        outputTokens: estimate(text.length + reasoning.length + JSON.stringify(wire).length),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }
    const reported = typeof usage?.cost === 'number' && Number.isFinite(usage.cost) ? Math.ceil(usage.cost * 1e6) : undefined
    const refused = (refusal.trim() && toolCalls.length === 0) || finish === 'content_filter'
    return {
      model,
      usage: counted,
      costMicros: reported ?? costMicros(`${setup.provider}:${model}`, counted),
      texts: text.trim() ? [text] : [],
      notes: reasoning.trim() ? [reasoning] : [],
      calls: refused ? [] : toolCalls,
      stop: refused ? 'refusal' : finish === 'length' ? 'max_tokens' : toolCalls.length > 0 ? 'tool_use' : 'end',
      refusal: refused ? (refusal.trim() || 'The provider filtered this response.') : undefined,
    }
  }

  private async failure(response: Response): Promise<ProviderError> {
    let detail = ''
    try {
      const raw = (await response.json()) as { error?: { message?: string } | Array<{ error?: { message?: string } }> }
      const error = Array.isArray(raw) ? raw[0]?.error : raw.error
      detail = String(error?.message ?? '').slice(0, 300)
    } catch {
      // No readable body; the status says enough.
    }
    const { provider } = this.setup
    const status = response.status
    // Gemini answers a bad key with 400 "API key not valid" rather than 401.
    if (status === 401 || (status === 400 && /api key/i.test(detail))) {
      return new ProviderError('auth', provider, status, `The ${this.name} API key was rejected. Update it in agent settings.`)
    }
    if (status === 403) return new ProviderError('permission', provider, status, `The ${this.name} API key is not allowed to use this model.`)
    if (status === 402) return new ProviderError('permission', provider, status, `The ${this.name} account has run out of credit.`)
    if (status === 429) return new ProviderError('rate', provider, status, `The ${this.name} API rate limit was reached. Try again shortly.`)
    if (status === 400 || status === 404 || status === 422) {
      return new ProviderError('request', provider, status, `The ${this.name} API rejected the request${detail ? `: ${detail}` : ` (${status})`}`)
    }
    return new ProviderError('other', provider, status, `The ${this.name} API returned an error (${status}).`)
  }

  keepReply() {
    if (this.last) this.messages.push(this.last)
  }

  addResults(results: ToolResult[], guidance: string[]) {
    for (const r of results) {
      this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content })
    }
    if (guidance.length > 0) this.messages.push({ role: 'user', content: guidance.join('\n\n') })
  }

  addGuidance(guidance: string[]) {
    this.messages.push({ role: 'user', content: guidance.join('\n\n') })
  }
}
