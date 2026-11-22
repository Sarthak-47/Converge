import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'

/** Orders for a running turn, sent to whichever instance runs it. */
type Command = { op: 'cancel' | 'steer'; turnId: string; text?: string; requestId: string; replyTo: string }

const COMMANDS = 'converge:runner-commands'
/** A turn's lease: which instance runs it. The API ends turns whose lease lapsed (their runner died). */
const LEASE = (turnId: string) => `converge:runner-lease:${turnId}`
const LEASE_SECONDS = 30
const RENEW_MS = 10_000
const REPLY_TIMEOUT_MS = 2_000

export type LocalTurns = {
  /** Turn IDs running on this instance. */
  running(): Iterable<string>
  /** Acts on a turn if it runs here; false when it does not. */
  handle(op: Command['op'], turnId: string, text?: string): boolean
}

/**
 * Lets several runner instances share the work (design §7.5). Starting a turn and reverting one already work
 * on any instance; a running turn lives in one instance's memory, so a cancel or steer that lands elsewhere
 * is forwarded through Redis to the instance that runs it, and each instance keeps a lease on its turns.
 */
export class RunnerCluster {
  readonly instance = randomUUID()
  private readonly pub: Redis
  private readonly sub: Redis
  private readonly waiting = new Map<string, (ok: boolean) => void>()
  private readonly replies: string
  private readonly renew: NodeJS.Timeout

  constructor(url: string, private readonly local: LocalTurns, log: (event: string, fields?: Record<string, unknown>) => void) {
    const options = { maxRetriesPerRequest: 1, lazyConnect: false }
    this.pub = new Redis(url, options)
    this.sub = new Redis(url, options)
    for (const client of [this.pub, this.sub]) client.on('error', (e: Error) => log('REDIS_ERROR', { message: e.message }))
    this.replies = `converge:runner-replies:${this.instance}`
    void this.sub.subscribe(COMMANDS, this.replies)
    this.sub.on('message', (channel: string, raw: string) => {
      try {
        if (channel === this.replies) {
          const reply = JSON.parse(raw) as { requestId: string; ok: boolean }
          this.waiting.get(reply.requestId)?.(reply.ok)
          return
        }
        const command = JSON.parse(raw) as Command
        if (this.local.handle(command.op, command.turnId, command.text)) {
          void this.pub.publish(command.replyTo, JSON.stringify({ requestId: command.requestId, ok: true }))
        }
      } catch (error) {
        log('CLUSTER_MESSAGE_FAILED', { message: (error as Error).message })
      }
    })
    this.renew = setInterval(() => {
      for (const turnId of this.local.running()) void this.lease(turnId)
    }, RENEW_MS)
    this.renew.unref()
  }

  /** Takes (or renews) the lease on a turn this instance runs. */
  async lease(turnId: string): Promise<void> {
    await this.pub.set(LEASE(turnId), this.instance, 'EX', LEASE_SECONDS).catch(() => undefined)
  }

  async release(turnId: string): Promise<void> {
    await this.pub.del(LEASE(turnId)).catch(() => undefined)
  }

  /** Sends a cancel or steer to the instance running the turn; false if no instance answered. */
  async forward(op: Command['op'], turnId: string, text?: string): Promise<boolean> {
    const requestId = randomUUID()
    const answered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), REPLY_TIMEOUT_MS)
      this.waiting.set(requestId, (ok) => {
        clearTimeout(timer)
        resolve(ok)
      })
    })
    try {
      const command: Command = { op, turnId, text, requestId, replyTo: this.replies }
      await this.pub.publish(COMMANDS, JSON.stringify(command))
      return await answered
    } catch {
      return false
    } finally {
      this.waiting.delete(requestId)
    }
  }

  async close() {
    clearInterval(this.renew)
    await Promise.allSettled([this.sub.quit(), this.pub.quit()])
  }
}
