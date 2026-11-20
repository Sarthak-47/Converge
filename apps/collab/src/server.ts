import { Server } from '@hocuspocus/server'
import { Redis } from 'ioredis'
import pg from 'pg'
import type * as Y from 'yjs'
import { authenticate, checkOrigin, type ConnectionContext } from './auth.js'
import { config } from './config.js'
import { checkHealth } from './health.js'
import { handleInternal } from './internal.js'
import { checkMemories, type MemoryCheck } from './memory.js'
import { ConnectionLimiter, metrics, registry } from './metrics.js'
import { timingSafeEqual } from 'node:crypto'
import { childHeader, fromHeader } from './trace.js'
import { loadDocument, storeDocument } from './persistence.js'

// A connection attempt that hangs fails after 5 s, so a store fails (and is retried) instead of waiting forever.
const db = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000 })
// The pool emits 'error' when the database drops an idle connection. Unhandled, that event ends the process,
// and with it every open document; the pool replaces the connection on its own (found by fault injection).
db.on('error', (error) => log('ERROR', 'DATABASE_CONNECTION_LOST', { message: error.message }))
const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
redis.on('error', (error) => log('ERROR', 'REDIS_ERROR', { message: error.message }))

function log(level: 'INFO' | 'WARN' | 'ERROR', event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'collab', event, ...fields }))
}

async function reportMemoryChecks(checks: MemoryCheck[]) {
  const trace = fromHeader(undefined)
  const response = await fetch(`${config.apiUrl}/internal/memories/checked`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.internalToken, traceparent: childHeader(trace) },
    body: JSON.stringify({ checks }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`Reporting memory checks failed with ${response.status}`)
  log('INFO', 'MEMORIES_CHECKED', { changed: checks.length, stale: checks.filter((c) => c.status === 'STALE').length, traceId: trace.traceId })
}

const limiter = new ConnectionLimiter()

async function store(documentName: string, document: Y.Doc) {
  const started = performance.now()
  try {
    await storeDocument(db, documentName, document)
  } catch (error) {
    metrics.storeFailures.inc()
    throw error
  }
  const durationMs = performance.now() - started
  metrics.storeDuration.observe(durationMs)
  log('INFO', 'DOCUMENT_STORED', { fileId: documentName, durationMs: Math.round(durationMs) })
  // Notes pinned to this file are re-checked against what was just stored (design §13.10). Context, not
  // authority: a failure is logged and never blocks storing.
  checkMemories(db, documentName, document, reportMemoryChecks)
    .then((changed) => metrics.memoryChecks.inc({ outcome: changed > 0 ? 'changed' : 'unchanged' }))
    .catch((error: Error) => {
      metrics.memoryChecks.inc({ outcome: 'failed' })
      log('WARN', 'MEMORY_CHECK_FAILED', { fileId: documentName, message: error.message })
    })
}

/**
 * Hocuspocus stores again only after the next change, so a store that failed while the database was away would
 * leave the last edits unstored until someone typed again. Failed stores are retried with backoff for as long
 * as the same document stays loaded. A store writes the whole state, so once the document is unloaded (or
 * replaced by a newer load) the retry stops: a later load holds at least as much and stores it itself.
 */
const retries = new Map<string, ReturnType<typeof setTimeout>>()
function retryStore(documentName: string, document: Y.Doc, isCurrent: () => boolean, attempt = 1) {
  if (retries.has(documentName)) return
  const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1))
  const timer = setTimeout(() => {
    retries.delete(documentName)
    if (!isCurrent()) return
    store(documentName, document)
      .then(() => log('INFO', 'DOCUMENT_STORE_RECOVERED', { fileId: documentName, attempt }))
      .catch((error: Error) => {
        log('WARN', 'DOCUMENT_STORE_FAILED', { fileId: documentName, attempt, message: error.message })
        retryStore(documentName, document, isCurrent, attempt + 1)
      })
  }, delay)
  timer.unref()
  retries.set(documentName, timer)
}

function internalCaller(headers: Record<string, string | string[] | undefined>) {
  const presented = Buffer.from(String(headers['x-internal-token'] ?? ''))
  const expected = Buffer.from(config.internalToken)
  return expected.length > 0 && presented.length === expected.length && timingSafeEqual(presented, expected)
}

const server = new Server<ConnectionContext>({
  port: config.port,
  quiet: true,
  stopOnSignals: false,
  // Store at most every 2 s while typing continues, and never later than 10 s after the first change.
  debounce: 2000,
  maxDebounce: 10000,
  websocketOptions: { maxPayload: 2 * 1024 * 1024 },

  async onConnect(data) {
    try {
      await checkOrigin(data)
    } catch (error) {
      metrics.authRejections.inc({ reason: 'origin' })
      throw error
    }
  },

  async connected() {
    metrics.connections.inc({ service: 'collab' })
  },

  async onDisconnect({ socketId }) {
    metrics.connections.dec({ service: 'collab' })
    limiter.forget(socketId)
  },

  /** Per-connection message and byte budgets (design §7.4); a client beyond them is closed with 4429. */
  async beforeHandleMessage({ socketId, update }) {
    metrics.updateBytes.observe(update.length)
    if (!limiter.allow(socketId, update.length)) {
      metrics.rateLimited.inc()
      log('WARN', 'RATE_LIMITED', { socketId })
      throw { code: 4429, reason: 'Too many updates' }
    }
  },

  async afterLoadDocument() {
    metrics.documentsLoaded.inc()
  },

  async afterUnloadDocument() {
    metrics.documentsLoaded.dec()
  },

  async onAuthenticate(data) {
    try {
      const context = await authenticate(data)
      log('INFO', 'DOCUMENT_JOINED', { fileId: data.documentName, userId: context.userId, role: context.role })
      return context
    } catch (error) {
      log('WARN', 'AUTH_REJECTED', { fileId: data.documentName, reason: (error as Error).message })
      metrics.authRejections.inc({ reason: (error as Error).message.startsWith('Not authorized') ? 'ticket' : 'document' })
      throw error
    }
  },

  async onLoadDocument({ documentName, document }) {
    await loadDocument(db, documentName, document)
  },

  async onStoreDocument({ documentName, document, instance }) {
    try {
      await store(documentName, document)
    } catch (error) {
      log('WARN', 'DOCUMENT_STORE_FAILED', { fileId: documentName, attempt: 0, message: (error as Error).message })
      retryStore(documentName, document, () => instance.documents.get(documentName) === document)
      throw error
    }
  },

  async onRequest({ request, response, instance }) {
    if (request.url === '/metrics') {
      // Metrics are for the monitoring network only, like /internal (design §16.1).
      if (!internalCaller(request.headers)) {
        response.writeHead(401).end()
        throw null
      }
      response.writeHead(200, { 'Content-Type': registry.contentType })
      response.end(await registry.metrics())
      throw null
    }
    if (request.url === '/health') {
      const report = await checkHealth(db, redis)
      response.writeHead(report.status === 'UP' ? 200 : 503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(report))
      // Hocuspocus treats a thrown null as "request handled".
      throw null
    }
    if (await handleInternal(request, response, instance, db)) {
      throw null
    }
  },
})

await redis.connect().catch(() => undefined)
await server.listen()
log('INFO', 'COLLAB_STARTED', { port: config.port, originCheck: config.allowedOrigins.length > 0 })

const shutdown = async () => {
  // destroy() stores every loaded document before closing, so a clean stop loses nothing.
  await server.destroy()
  await Promise.allSettled([db.end(), redis.quit()])
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
