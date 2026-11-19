import Anthropic from '@anthropic-ai/sdk'
import type { Typing, UndoRecord } from './edits.js'
import { costMicros, type Usage } from './pricing.js'
import { TOOLS, Toolbox } from './tools.js'
import type { TurnWorkspace } from './workspace.js'

export type TurnRequest = {
  turnId: string
  workspaceId: string
  sponsor: { id: string; name: string }
  apiKey: string
  model: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  prompt: string
  /** Earlier exchanges in this lane, oldest first. */
  history: Array<{ prompt: string; reply: string }>
  costCapMicros: number
}

export type TurnStatus = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUSED' | 'BUDGET_EXCEEDED'

export type TurnEvent =
  | { kind: 'text'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'tool'; name: string; summary: string; ok: boolean }

/** Where a turn reports to: the API, which stores the transcript and cost ledger (design §13.5). */
export interface TurnLedger {
  event(event: TurnEvent): Promise<void>
  /** Records one response's usage; returns the turn's running total. */
  usage(usage: Usage & { model: string; costMicros: number }): Promise<{ costMicros: number }>
  saveRevertState(fileId: string, state: Uint8Array, undo: UndoRecord): Promise<void>
  finish(status: TurnStatus, error?: string): Promise<void>
}

export type TurnOptions = {
  workspace: TurnWorkspace
  ledger: TurnLedger
  signal: AbortSignal
  typing: Typing
  baseURL?: string
  fallbacks: boolean
}

const MAX_RESPONSES = 50
const MAX_TOKENS = 64_000
const TASK_BUDGET_TOKENS = 200_000

const SYSTEM = `You are a coding agent working inside Converge, a shared editor where several people and their agents edit the same files at the same time.

- Your edits appear live in teammates' editors with your own cursor. Make focused, minimal edits with edit_file instead of rewriting whole files.
- Teammates may be typing in the files you work on. If an edit fails because the text changed, read the file again and retry against the current text; never undo or overwrite someone else's work.
- You can read, search, edit and create files. You cannot run commands, install packages or delete files; if the task needs that, say what should be run.
- Keep replies short. When you finish, summarize what you changed in a few sentences.`

/** A short, safe error message for the lane; never includes the key or request details. */
function describe(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Update it in agent settings.'
  if (error instanceof Anthropic.PermissionDeniedError) return 'The Anthropic API key is not allowed to use this model.'
  if (error instanceof Anthropic.RateLimitError) return 'The Anthropic API rate limit was reached. Try again shortly.'
  if (error instanceof Anthropic.BadRequestError) return `The Claude API rejected the request: ${error.message.slice(0, 300)}`
  if (error instanceof Anthropic.APIError) return `The Claude API returned an error (${error.status ?? 'network'}).`
  return 'The agent stopped because of an internal error.'
}

/**
 * Runs one agent turn (design §13.4): a streaming tool-use loop on the Claude API where every tool works on
 * the live documents. Usage is recorded after every response and the turn stops at its cost cap; a cancel
 * takes effect at once during a request and otherwise at the next checkpoint between tool calls.
 */
export async function runTurn(request: TurnRequest, options: TurnOptions): Promise<TurnStatus> {
  const { workspace, ledger, signal } = options
  const client = new Anthropic({ apiKey: request.apiKey, baseURL: options.baseURL, maxRetries: 2 })
  const toolbox = new Toolbox(workspace, `agent:${request.turnId}`, options.typing)
  const messages: Anthropic.Beta.BetaMessageParam[] = []
  for (const past of request.history) {
    messages.push({ role: 'user', content: past.prompt }, { role: 'assistant', content: past.reply || '(no reply)' })
  }
  messages.push({ role: 'user', content: `${request.sponsor.name} asks:\n\n${request.prompt}` })

  let status: TurnStatus = 'FAILED'
  let error: string | undefined
  let jsonRetries = 0
  try {
    for (let response = 0; ; response++) {
      if (signal.aborted) {
        status = 'CANCELLED'
        break
      }
      if (response >= MAX_RESPONSES) {
        status = 'FAILED'
        error = `The turn reached its limit of ${MAX_RESPONSES} model responses.`
        break
      }
      const stream = client.beta.messages.stream(
        {
          model: request.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM,
          tools: TOOLS,
          messages,
          thinking: { type: 'adaptive', display: 'updates' },
          output_config: { effort: request.effort, task_budget: { type: 'tokens', total: TASK_BUDGET_TOKENS } },
          cache_control: { type: 'ephemeral' },
          betas: [
            'task-budgets-2026-03-13',
            'thinking-display-updates-2026-08-18',
            ...(options.fallbacks ? (['server-side-fallback-2026-07-01'] as const) : []),
          ],
          ...(options.fallbacks ? { fallbacks: 'default' as const } : {}),
        },
        { signal },
      )
      let message: Anthropic.Beta.BetaMessage
      try {
        message = await stream.finalMessage()
        jsonRetries = 0
      } catch (failure) {
        // Unparseable streamed tool input or a dropped connection: re-issue a few times. API errors and
        // cancellation are not retried here.
        if (failure instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw failure
        continue
      }

      const usage: Usage = {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      }
      const total = await ledger.usage({ ...usage, model: message.model, costMicros: costMicros(message.model, usage) })

      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) await ledger.event({ kind: 'text', text: block.text })
        if (block.type === 'thinking' && block.thinking.trim()) await ledger.event({ kind: 'note', text: block.thinking })
      }

      if (message.stop_reason === 'refusal') {
        // A refusal can cut a tool call off mid-input, so this response's tools never run.
        status = 'REFUSED'
        error = message.stop_details?.explanation ?? 'The model declined this request.'
        break
      }
      if (total.costMicros >= request.costCapMicros) {
        status = 'BUDGET_EXCEEDED'
        error = 'The turn reached its cost cap.'
        break
      }
      if (message.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: message.content })
        continue
      }
      const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      if (calls.length === 0) {
        status = 'SUCCEEDED'
        if (message.stop_reason === 'max_tokens') error = 'The reply was cut off at the output limit.'
        break
      }
      if (message.stop_reason === 'max_tokens') {
        // A tool input cut off at the limit can still parse as a valid, truncated object.
        status = 'FAILED'
        error = 'A tool call was cut off at the output limit.'
        break
      }

      messages.push({ role: 'assistant', content: message.content })
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
      for (const call of calls) {
        if (signal.aborted) {
          results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'Cancelled by the sponsor.' })
          continue
        }
        const outcome = await toolbox.run(call.name, call.input)
        await ledger.event({ kind: 'tool', name: call.name, summary: outcome.summary, ok: !outcome.isError })
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: outcome.isError || undefined, content: outcome.content })
      }
      // Every result goes back in one user message, as the API expects for parallel calls.
      messages.push({ role: 'user', content: results })
    }
  } catch (failure) {
    if (signal.aborted || failure instanceof Anthropic.APIUserAbortError) {
      status = 'CANCELLED'
    } else {
      status = 'FAILED'
      error = describe(failure)
      if (!(failure instanceof Anthropic.APIError)) console.error(JSON.stringify({ level: 'ERROR', event: 'TURN_CRASHED', turnId: request.turnId, message: (failure as Error).message }))
    }
  }

  // Whatever happened, everything the agent typed is kept revertible and delivered before the turn ends.
  try {
    for (const record of toolbox.records()) await ledger.saveRevertState(record.fileId, record.state, record.undo)
    await workspace.flush()
  } finally {
    toolbox.dispose()
    await workspace.close()
  }
  await ledger.finish(status, error)
  return status
}
