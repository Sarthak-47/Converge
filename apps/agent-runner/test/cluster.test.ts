import { Redis } from 'ioredis'
import { afterEach, describe, expect, it } from 'vitest'
import { RunnerCluster } from '../src/cluster.js'

/**
 * Two runner instances against a real Redis (RUNNER_TEST_REDIS_URL; CI provides one). A cancel or steer that
 * lands on the wrong instance reaches the one running the turn, and leases record who runs what.
 */
const url = process.env.RUNNER_TEST_REDIS_URL

function instance(turns: string[]) {
  const seen: Array<{ op: string; turnId: string; text?: string }> = []
  const cluster = new RunnerCluster(url!, {
    running: () => turns,
    handle: (op, turnId, text) => {
      if (!turns.includes(turnId)) return false
      seen.push({ op, turnId, text })
      return true
    },
  }, () => undefined)
  return { cluster, seen }
}

const open: RunnerCluster[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()))
})

describe.skipIf(!url)('several runner instances', () => {
  it('forwards a cancel or steer to the instance running the turn', async () => {
    const a = instance([])
    const b = instance(['turn-on-b'])
    open.push(a.cluster, b.cluster)
    await new Promise((resolve) => setTimeout(resolve, 200)) // subscriptions settle

    expect(await a.cluster.forward('steer', 'turn-on-b', 'use the helper')).toBe(true)
    expect(await a.cluster.forward('cancel', 'turn-on-b')).toBe(true)
    expect(b.seen).toEqual([
      { op: 'steer', turnId: 'turn-on-b', text: 'use the helper' },
      { op: 'cancel', turnId: 'turn-on-b' },
    ])
    // No instance runs it: the caller learns so instead of waiting forever.
    expect(await a.cluster.forward('cancel', 'turn-nowhere')).toBe(false)
  })

  it('keeps a lease on each running turn and releases it at the end', async () => {
    const a = instance(['turn-leased'])
    open.push(a.cluster)
    const redis = new Redis(url!)
    try {
      await a.cluster.lease('turn-leased')
      expect(await redis.get('converge:runner-lease:turn-leased')).toBe(a.cluster.instance)
      expect(await redis.ttl('converge:runner-lease:turn-leased')).toBeGreaterThan(20)
      await a.cluster.release('turn-leased')
      expect(await redis.exists('converge:runner-lease:turn-leased')).toBe(0)
    } finally {
      redis.disconnect()
    }
  })
})
