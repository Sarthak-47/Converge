import type { UndoRecord } from './edits.js'
import type { Usage } from './pricing.js'
import type { TurnEvent, TurnLedger, TurnStatus } from './turn.js'
import type { FileEntry, SearchHit } from './workspace.js'

/**
 * The runner's side of the API boundary (design §5.3): every call is scoped to one turn, so the API checks
 * the turn is live and its sponsor still holds the right role before answering.
 */
export class TurnApi implements TurnLedger {
  private readonly base: string

  constructor(apiUrl: string, private readonly token: string, readonly turnId: string) {
    this.base = `${apiUrl.replace(/\/$/, '')}/internal/agent/turns/${encodeURIComponent(turnId)}`
  }

  tree(): Promise<FileEntry[]> {
    return this.call('GET', '/tree')
  }

  search(query: string): Promise<SearchHit[]> {
    return this.call('GET', `/search?q=${encodeURIComponent(query)}`)
  }

  async ticket(fileId: string): Promise<string> {
    return (await this.call<{ ticket: string }>('POST', '/tickets', { fileId })).ticket
  }

  createFile(path: string): Promise<FileEntry> {
    return this.call('POST', '/files', { path })
  }

  async event(event: TurnEvent): Promise<void> {
    await this.call('POST', '/events', event)
  }

  usage(usage: Usage & { model: string; costMicros: number }): Promise<{ costMicros: number }> {
    return this.call('POST', '/usage', usage)
  }

  async saveRevertState(fileId: string, state: Uint8Array, undo: UndoRecord): Promise<void> {
    await this.call('PUT', `/files/${encodeURIComponent(fileId)}/revert-state`, {
      state: Buffer.from(state).toString('base64'),
      undo,
    })
  }

  async finish(status: TurnStatus, error?: string): Promise<void> {
    await this.call('POST', '/finish', { status, error: error ?? null })
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        'X-Internal-Token': this.token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      let message = `${method} ${path} failed with ${response.status}`
      try {
        const problem = (await response.json()) as { message?: unknown; detail?: unknown }
        const detail = problem.message ?? problem.detail
        if (typeof detail === 'string') message = detail
      } catch {
        // keep the status-only message
      }
      throw new ApiCallError(response.status, message)
    }
    if (response.status === 204) return undefined as T
    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
  }
}

export class ApiCallError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}
