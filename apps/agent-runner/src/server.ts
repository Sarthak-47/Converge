import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { TurnApi } from './apiClient.js'
import { CollabWorkspace } from './collabWorkspace.js'
import { config } from './config.js'
import { revertTurn } from './edits.js'
import { fromHeader, type TraceContext } from './trace.js'
import { runTurn } from './turn.js'
import { TEXT_FIELD } from './workspace.js'

function log(level: 'INFO' | 'WARN' | 'ERROR', event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'agent-runner', event, ...fields }))
}

const TurnStart = z.object({
  turnId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sponsor: z.object({ id: z.string().uuid(), name: z.string().min(1).max(200) }),
  apiKey: z.string().min(1).max(500),
  model: z.string().min(1).max(100),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  prompt: z.string().min(1).max(20_000),
  history: z.array(z.object({ prompt: z.string(), reply: z.string() })).max(20),
  costCapMicros: z.number().int().positive(),
  session: z.object({ id: z.string().uuid(), task: z.string().min(1).max(2000) }).nullable().optional(),
  context: z.string().max(40_000).nullable().optional(),
})

const Steer = z.object({ text: z.string().min(1).max(4000) })

const Range = z.array(z.tuple([z.number().int().nonnegative(), z.number().int().positive()]))
const RevertRequest = z.object({
  actorName: z.string().min(1).max(200),
  files: z.array(z.object({
    fileId: z.string().uuid(),
    state: z.string(),
    undo: z.object({ insertions: z.record(z.string(), Range), deletions: z.record(z.string(), Range) }),
  })).max(500),
})

/** Turns in progress on this runner, by turn ID, so the sponsor can cancel or steer them. */
const running = new Map<string, AbortController>()
const guidance = new Map<string, string[]>()

function authorized(request: IncomingMessage): boolean {
  const presented = Buffer.from(String(request.headers['x-internal-token'] ?? ''))
  const expected = Buffer.from(config.internalToken)
  return expected.length > 0 && presented.length === expected.length && timingSafeEqual(presented, expected)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > 50 * 1024 * 1024) throw new Error('Body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
}

function reply(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

function startTurn(input: z.infer<typeof TurnStart>, trace: TraceContext) {
  const controller = new AbortController()
  running.set(input.turnId, controller)
  // The whole turn continues the API's trace: its log lines and its calls back to the API share one trace ID.
  const api = new TurnApi(config.apiUrl, config.internalToken, input.turnId, trace)
  const traced = { traceId: trace.traceId }
  const workspace = new CollabWorkspace(api, `${input.sponsor.name}'s agent`, {
    collabUrl: config.collabUrl,
    origin: config.collabOrigin,
  })
  log('INFO', 'TURN_STARTED', { turnId: input.turnId, workspaceId: input.workspaceId, model: input.model, ...traced })
  void runTurn(input, {
    workspace,
    ledger: api,
    signal: controller.signal,
    typing: { chunk: config.typingChunk, delayMs: config.typingDelayMs },
    baseURL: config.anthropicBaseUrl,
    fallbacks: config.fallbacks,
    takeGuidance: () => {
      const queued = guidance.get(input.turnId) ?? []
      guidance.set(input.turnId, [])
      return queued
    },
  })
    .then((status) => log('INFO', 'TURN_ENDED', { turnId: input.turnId, status, ...traced }))
    .catch((error: Error) => {
      log('ERROR', 'TURN_REPORT_FAILED', { turnId: input.turnId, message: error.message, ...traced })
      return api.finish('FAILED', 'The agent runner could not complete the turn.').catch(() => undefined)
    })
    .finally(() => {
      running.delete(input.turnId)
      guidance.delete(input.turnId)
    })
}

/**
 * Reverts a finished turn (design §13.2): each document is loaded from the state saved at the end of the
 * turn, synced with the live document, and the turn's own changes are undone as one new edit.
 */
async function revert(turnId: string, input: z.infer<typeof RevertRequest>, trace: TraceContext): Promise<number> {
  const api = new TurnApi(config.apiUrl, config.internalToken, turnId, trace)
  const workspace = new CollabWorkspace(api, `${input.actorName} (reverting an agent turn)`, {
    collabUrl: config.collabUrl,
    origin: config.collabOrigin,
  })
  let reverted = 0
  try {
    for (const file of input.files) {
      const doc = await workspace.open(file.fileId, new Uint8Array(Buffer.from(file.state, 'base64')))
      if (revertTurn(doc.getText(TEXT_FIELD), file.undo, `revert:${turnId}`)) reverted++
    }
    await workspace.flush()
  } finally {
    await workspace.close()
  }
  return reverted
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://runner')
    if (request.method === 'GET' && url.pathname === '/health') {
      return reply(response, 200, { status: 'UP', runningTurns: running.size })
    }
    if (!url.pathname.startsWith('/internal/')) return reply(response, 404)
    if (!authorized(request)) return reply(response, 401)

    if (request.method === 'POST' && url.pathname === '/internal/turns') {
      const parsed = TurnStart.safeParse(await readJson(request))
      if (!parsed.success) return reply(response, 400, { message: 'Invalid turn request' })
      if (running.has(parsed.data.turnId)) return reply(response, 409, { message: 'Turn already running' })
      startTurn(parsed.data, fromHeader(request.headers.traceparent))
      return reply(response, 202, { accepted: true })
    }
    const cancel = /^\/internal\/turns\/([0-9a-f-]{36})\/cancel$/i.exec(url.pathname)
    if (request.method === 'POST' && cancel) {
      const controller = running.get(cancel[1]!)
      if (!controller) return reply(response, 404, { message: 'Turn is not running here' })
      controller.abort()
      return reply(response, 202, { cancelling: true })
    }
    const steer = /^\/internal\/turns\/([0-9a-f-]{36})\/steer$/i.exec(url.pathname)
    if (request.method === 'POST' && steer) {
      const parsed = Steer.safeParse(await readJson(request))
      if (!parsed.success) return reply(response, 400, { message: 'Invalid guidance' })
      if (!running.has(steer[1]!)) return reply(response, 404, { message: 'Turn is not running here' })
      guidance.set(steer[1]!, [...(guidance.get(steer[1]!) ?? []), parsed.data.text])
      return reply(response, 202, { queued: true })
    }
    const revertMatch = /^\/internal\/turns\/([0-9a-f-]{36})\/revert$/i.exec(url.pathname)
    if (request.method === 'POST' && revertMatch) {
      const parsed = RevertRequest.safeParse(await readJson(request))
      if (!parsed.success) return reply(response, 400, { message: 'Invalid revert request' })
      const trace = fromHeader(request.headers.traceparent)
      const reverted = await revert(revertMatch[1]!, parsed.data, trace)
      log('INFO', 'TURN_REVERTED', { turnId: revertMatch[1], files: reverted, traceId: trace.traceId })
      return reply(response, 200, { revertedFiles: reverted })
    }
    return reply(response, 404)
  })().catch((error: Error) => {
    log('ERROR', 'REQUEST_FAILED', { path: request.url, message: error.message })
    if (!response.headersSent) reply(response, 500, { message: 'Internal error' })
  })
})

server.listen(config.port, () => log('INFO', 'RUNNER_STARTED', { port: config.port, fakeModel: Boolean(config.anthropicBaseUrl) }))

const shutdown = () => {
  for (const controller of running.values()) controller.abort()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
