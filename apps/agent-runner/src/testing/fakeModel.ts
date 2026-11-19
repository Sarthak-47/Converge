import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A scripted stand-in for the Claude Messages API, used by tests and the end-to-end stack so agent turns are
 * deterministic and free. It streams real server-sent events, so the official SDK parses them exactly as it
 * would the real API.
 *
 * The script is read from the latest prompt, one directive per line:
 *   @tool <name> <json input>   respond with that tool call (one call per response, in order)
 *   @say <text>                 respond with text before continuing
 *   @refuse                     stop with stop_reason "refusal"
 *   @slow <ms>                  wait before every later response (for cancellation tests)
 * After the last directive it ends the turn with "Done.". A prompt without directives gets a short reply.
 */
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
type Step = { kind: 'tool'; name: string; input: unknown } | { kind: 'say'; text: string } | { kind: 'refuse' }

export type RecordedRequest = { apiKey: string | undefined; beta: string | undefined; body: Record<string, unknown> }

type Message = { role: string; content: unknown }

function parseScript(prompt: string): { steps: Step[]; delayMs: number } {
  const steps: Step[] = []
  let delayMs = 0
  for (const raw of prompt.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('@tool ')) {
      const rest = line.slice(6)
      const space = rest.indexOf(' ')
      const name = space === -1 ? rest : rest.slice(0, space)
      const input = space === -1 ? {} : JSON.parse(rest.slice(space + 1))
      steps.push({ kind: 'tool', name, input })
    } else if (line.startsWith('@say ')) {
      steps.push({ kind: 'say', text: line.slice(5) })
    } else if (line === '@refuse') {
      steps.push({ kind: 'refuse' })
    } else if (line.startsWith('@slow ')) {
      delayMs = Number(line.slice(6)) || 0
    }
  }
  return { steps, delayMs }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => (b?.type === 'text' ? String(b.text) : '')).join('')
  return ''
}

/** The prompt that started this turn and how many responses the model has given since. */
function position(messages: Message[]): { prompt: string; responses: number } {
  let start = messages.length - 1
  while (start > 0 && !(messages[start]!.role === 'user' && typeof messages[start]!.content === 'string')) start--
  const responses = messages.slice(start).filter((m) => m.role === 'assistant').length
  return { prompt: textOf(messages[start]?.content), responses }
}

export class FakeModel {
  readonly requests: RecordedRequest[] = []
  private server: Server | null = null
  private ids = 0

  /** Tokens reported for every response. */
  usage = { input_tokens: 1000, output_tokens: 200 }

  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve))
    const address = this.server.address() as AddressInfo
    return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`
  }

  async stop() {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"UP"}')
      return
    }
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    const header = (name: string) => {
      const value = req.headers[name]
      return Array.isArray(value) ? value.join(',') : value
    }
    // SDK 1.x sends the key as a bearer token; older clients use x-api-key.
    const apiKey = header('x-api-key') ?? header('authorization')?.replace(/^Bearer /, '')
    this.requests.push({ apiKey, beta: header('anthropic-beta'), body })

    if (apiKey === 'sk-ant-invalid') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
      return
    }

    const { prompt, responses } = position(body.messages as Message[])
    const { steps, delayMs } = parseScript(prompt)
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))

    const step = steps[responses]
    let blocks: Block[]
    let stopReason: string
    if (steps.length === 0) {
      blocks = [{ type: 'text', text: 'This is the scripted test model. Add @tool lines to the prompt to drive it.' }]
      stopReason = 'end_turn'
    } else if (!step) {
      blocks = [{ type: 'text', text: 'Done.' }]
      stopReason = 'end_turn'
    } else if (step.kind === 'refuse') {
      blocks = []
      stopReason = 'refusal'
    } else if (step.kind === 'say') {
      // A text-only response would end the turn, so text is paired with a harmless read.
      blocks = [{ type: 'text', text: step.text }, { type: 'tool_use', id: this.id('toolu'), name: 'list_files', input: {} }]
      stopReason = 'tool_use'
    } else {
      blocks = [{ type: 'tool_use', id: this.id('toolu'), name: step.name, input: step.input }]
      stopReason = 'tool_use'
    }
    const message = {
      id: this.id('msg'),
      type: 'message',
      role: 'assistant',
      model: String(body.model),
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: stopReason === 'refusal' ? { type: 'refusal', category: null, explanation: 'Scripted refusal.' } : null,
      usage: { ...this.usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
    if (body.stream) this.stream(res, message, blocks)
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message))
  }

  private stream(res: ServerResponse, message: Record<string, unknown> & { usage: object }, blocks: Block[]) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
    send('message_start', {
      message: { ...message, content: [], stop_reason: null, stop_details: null, usage: { ...message.usage, output_tokens: 1 } },
    })
    blocks.forEach((block, index) => {
      if (block.type === 'text') {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
      } else {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
        // Split the input JSON, as eager input streaming does.
        const json = JSON.stringify(block.input)
        for (let i = 0; i < json.length; i += 16) {
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 16) } })
        }
      }
      send('content_block_stop', { index })
    })
    send('message_delta', {
      delta: { stop_reason: message.stop_reason, stop_sequence: null, stop_details: message.stop_details },
      usage: { output_tokens: (message.usage as { output_tokens: number }).output_tokens },
    })
    send('message_stop', {})
    res.end()
  }

  private id(prefix: string) {
    return `${prefix}_fake${String(++this.ids).padStart(6, '0')}`
  }
}
