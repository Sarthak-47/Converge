import { Server } from '@hocuspocus/server'
import { Redis } from 'ioredis'
import pg from 'pg'
import { authenticate, checkOrigin, type ConnectionContext } from './auth.js'
import { config } from './config.js'
import { checkHealth } from './health.js'
import { handleInternal } from './internal.js'
import { loadDocument, storeDocument } from './persistence.js'

const db = new pg.Pool({ connectionString: config.databaseUrl, max: 10 })
const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
redis.on('error', (error) => log('ERROR', 'REDIS_ERROR', { message: error.message }))

function log(level: 'INFO' | 'WARN' | 'ERROR', event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'collab', event, ...fields }))
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
    await checkOrigin(data)
  },

  async onAuthenticate(data) {
    try {
      const context = await authenticate(data)
      log('INFO', 'DOCUMENT_JOINED', { fileId: data.documentName, userId: context.userId, role: context.role })
      return context
    } catch (error) {
      log('WARN', 'AUTH_REJECTED', { fileId: data.documentName, reason: (error as Error).message })
      throw error
    }
  },

  async onLoadDocument({ documentName, document }) {
    await loadDocument(db, documentName, document)
  },

  async onStoreDocument({ documentName, document }) {
    const started = performance.now()
    await storeDocument(db, documentName, document)
    log('INFO', 'DOCUMENT_STORED', { fileId: documentName, durationMs: Math.round(performance.now() - started) })
  },

  async onRequest({ request, response, instance }) {
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
