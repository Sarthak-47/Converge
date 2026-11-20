import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

/**
 * The collaboration service's metrics (design §16.1), served on /metrics to holders of the internal token.
 * Names follow the design's table so dashboards and the baseline report agree.
 */
export const registry = new Registry()
collectDefaultMetrics({ register: registry, prefix: 'collab_' })

export const metrics = {
  connections: new Gauge({ name: 'websocket_active_connections', help: 'Open document connections', labelNames: ['service'], registers: [registry] }),
  authRejections: new Counter({ name: 'ws_auth_rejections_total', help: 'Rejected handshakes', labelNames: ['reason'], registers: [registry] }),
  documentsLoaded: new Gauge({ name: 'collab_documents_loaded', help: 'Documents held in memory', registers: [registry] }),
  storeDuration: new Histogram({
    name: 'collab_store_duration_ms', help: 'Time to store a document', registers: [registry],
    buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  }),
  storeFailures: new Counter({ name: 'collab_store_failures_total', help: 'Failed document stores', registers: [registry] }),
  externalChanges: new Counter({ name: 'external_changes_applied_total', help: 'Changes merged from outside the editor', labelNames: ['reason'], registers: [registry] }),
  updateBytes: new Histogram({
    name: 'document_update_bytes', help: 'Size of document updates received', registers: [registry],
    buckets: [16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576],
  }),
  rateLimited: new Counter({ name: 'ws_rate_limited_total', help: 'Connections closed for sending too much', registers: [registry] }),
  memoryChecks: new Counter({ name: 'memory_checks_total', help: 'Notes re-checked after a store', labelNames: ['outcome'], registers: [registry] }),
}
metrics.connections.set({ service: 'collab' }, 0)

/**
 * Per-connection token buckets (design §7.4 step 3): a burst allowance that refills over time, for messages
 * and for bytes. Generous enough for fast typing and pastes; a client beyond it is closed with 4429.
 */
export class ConnectionLimiter {
  private readonly buckets = new Map<string, { messages: number; bytes: number; at: number }>()

  constructor(
    private readonly messagesPerSecond = 100,
    private readonly messageBurst = 400,
    private readonly bytesPerSecond = 1024 * 1024,
    private readonly byteBurst = 4 * 1024 * 1024,
  ) {}

  /** Spends one message of `size` bytes; false when the connection has gone over its allowance. */
  allow(socketId: string, size: number, now = Date.now()): boolean {
    const bucket = this.buckets.get(socketId) ?? { messages: this.messageBurst, bytes: this.byteBurst, at: now }
    const elapsed = Math.max(0, now - bucket.at) / 1000
    bucket.messages = Math.min(this.messageBurst, bucket.messages + elapsed * this.messagesPerSecond)
    bucket.bytes = Math.min(this.byteBurst, bucket.bytes + elapsed * this.bytesPerSecond)
    bucket.at = now
    bucket.messages -= 1
    bucket.bytes -= size
    this.buckets.set(socketId, bucket)
    return bucket.messages >= 0 && bucket.bytes >= 0
  }

  forget(socketId: string) {
    this.buckets.delete(socketId)
  }
}
