import { randomUUID } from 'node:crypto'
import { Redis as RedisSync } from '@hocuspocus/extension-redis'
import type { Redis } from 'ioredis'
import { config } from './config.js'
import type { RevokeAction } from './revoke.js'

/**
 * Several collaboration-service instances (design §7.5), when COLLAB_CLUSTER=true. Hocuspocus's Redis
 * extension keeps every instance's copy of a document in step, and makes an instance that opens a document
 * live elsewhere wait for that instance's state first, so an API call landing on any instance (applying text,
 * storing before a push) sees the latest text. It also lets only one instance store a document at a time.
 * The service's own commands that act on connections (close a deleted file, apply a role change) are
 * broadcast here, since the connections they concern may be held by any instance.
 */
export const instanceId = randomUUID()

export function documentSync(): RedisSync | null {
  if (!config.cluster) return null
  const url = new URL(config.redisUrl)
  return new RedisSync({
    host: url.hostname,
    port: Number(url.port || 6379),
    options: { password: url.password ? decodeURIComponent(url.password) : undefined },
    identifier: instanceId,
    prefix: 'converge-collab',
    // Long enough for a peer under load to answer; a lone load skips the wait entirely.
    awaitInitialSyncTimeout: 3000,
  })
}

export type Command =
  | { type: 'close'; fileId: string }
  | { type: 'revoke'; userId: string; workspaceId: string; action: RevokeAction }
  /** Store your copy of this document now, then answer. */
  | { type: 'flush'; fileId: string; requestId: string; replyTo: string }
  | { type: 'flushed'; requestId: string; to: string }

/** What the internal routes need from the cluster; a single instance gets the no-op version. */
export type ClusterPort = {
  share(command: Command): void
  /** Makes every other instance holding the document store its copy, and waits for them. */
  flushPeers(fileId: string, selfHolds: boolean): Promise<void>
}

export const SOLO: ClusterPort = { share: () => undefined, flushPeers: async () => undefined }

const FLUSH_TIMEOUT_MS = 3000

const CHANNEL = 'converge:collab-commands'

/** Broadcasts commands to the other instances, and applies theirs here. A no-op when not clustered. */
export class CommandBus implements ClusterPort {
  private subscriber: Redis | null = null
  private readonly pending = new Map<string, { remaining: number; done: () => void }>()

  constructor(private readonly redis: Redis, private readonly apply: (command: Command) => void | Promise<void>,
    private readonly log: (event: string, fields: Record<string, unknown>) => void) {}

  async start() {
    if (!config.cluster) return
    this.subscriber = this.redis.duplicate()
    this.subscriber.on('error', (error: Error) => this.log('COMMAND_BUS_ERROR', { message: error.message }))
    this.subscriber.on('message', (_channel: string, message: string) => {
      try {
        const envelope = JSON.parse(message) as { from: string; command: Command }
        if (envelope.from === instanceId) return
        const command = envelope.command
        if (command.type === 'flushed') {
          if (command.to === instanceId) this.answered(command.requestId)
          return
        }
        Promise.resolve(this.apply(command)).catch((error: Error) => this.log('COMMAND_FAILED', { type: command.type, message: error.message }))
      } catch (error) {
        this.log('COMMAND_IGNORED', { message: (error as Error).message })
      }
    })
    await this.subscriber.subscribe(CHANNEL)
  }

  /** Tells the other instances; this instance has already applied the command itself. */
  share(command: Command) {
    if (!config.cluster) return
    this.redis.publish(CHANNEL, JSON.stringify({ from: instanceId, command }))
      .catch((error: Error) => this.log('COMMAND_NOT_SHARED', { type: command.type, message: error.message }))
  }

  /** Answers a peer's flush request once this instance's copy is stored. */
  flushed(requestId: string, to: string) {
    this.share({ type: 'flushed', requestId, to })
  }

  async flushPeers(fileId: string, selfHolds: boolean): Promise<void> {
    if (!config.cluster) return
    // Every instance holding the document is subscribed to its channel in the document-sync extension.
    const [, subscribers] = (await this.redis.pubsub('NUMSUB', `converge-collab:${fileId}`)) as [string, number]
    const expected = Number(subscribers) - (selfHolds ? 1 : 0)
    if (expected <= 0) return
    const requestId = randomUUID()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.log('FLUSH_PEERS_TIMED_OUT', { fileId, expected })
        resolve()
      }, FLUSH_TIMEOUT_MS)
      this.pending.set(requestId, { remaining: expected, done: () => { clearTimeout(timer); resolve() } })
      this.share({ type: 'flush', fileId, requestId, replyTo: instanceId })
    })
  }

  private answered(requestId: string) {
    const waiting = this.pending.get(requestId)
    if (!waiting) return
    waiting.remaining--
    if (waiting.remaining <= 0) {
      this.pending.delete(requestId)
      waiting.done()
    }
  }

  async stop() {
    await this.subscriber?.quit().catch(() => undefined)
  }
}
