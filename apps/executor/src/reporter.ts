import type { Stream } from './sandbox.js'

type Chunk = { stream: Stream; chunk: string }

/**
 * Reports a job's progress to the API, which stores it and streams it to everyone in the workspace. Output is
 * batched briefly so a chatty test run does not become thousands of requests.
 */
export class Reporter {
  private pending: Chunk[] = []
  private timer: NodeJS.Timeout | null = null
  private sending: Promise<void> = Promise.resolve()

  constructor(private readonly apiUrl: string, private readonly token: string, readonly jobId: string) {}

  output(stream: Stream, chunk: string) {
    const last = this.pending.at(-1)
    if (last && last.stream === stream && last.chunk.length < 16_000) last.chunk += chunk
    else this.pending.push({ stream, chunk })
    this.timer ??= setTimeout(() => this.drain(), 200)
  }

  /** Sends whatever output is waiting. */
  flush(): Promise<void> {
    this.drain()
    return this.sending
  }

  async status(status: string, extra: { exitCode?: number | null; error?: string } = {}) {
    await this.flush()
    await this.post('/status', { status, exitCode: extra.exitCode ?? null, error: extra.error ?? null })
  }

  async notify() {
    await this.post('/notify', {})
  }

  private drain() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending.length === 0) return
    const chunks = this.pending
    this.pending = []
    this.sending = this.sending
      .then(() => this.post('/output', { chunks }))
      .catch((error: Error) => console.log(JSON.stringify({ level: 'WARN', event: 'OUTPUT_REPORT_FAILED', jobId: this.jobId, message: error.message })))
  }

  private async post(path: string, body: unknown) {
    const response = await fetch(`${this.apiUrl.replace(/\/$/, '')}/internal/jobs/${this.jobId}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': this.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`POST ${path} failed with ${response.status}`)
  }
}
