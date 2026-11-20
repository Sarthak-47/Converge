import { describe, expect, it } from 'vitest'
import { ConnectionLimiter } from './metrics.js'

describe('per-connection rate limits (design §7.4)', () => {
  it('allows a burst, refuses beyond it, and refills over time', () => {
    const limiter = new ConnectionLimiter(10, 20, 1_000_000, 1_000_000)
    for (let i = 0; i < 20; i++) expect(limiter.allow('a', 10, 0)).toBe(true)
    expect(limiter.allow('a', 10, 0)).toBe(false)
    // Another connection has its own allowance.
    expect(limiter.allow('b', 10, 0)).toBe(true)
    // One second later, ten more messages fit.
    for (let i = 0; i < 9; i++) expect(limiter.allow('a', 10, 1000)).toBe(true)
  })

  it('limits bytes as well as messages', () => {
    const limiter = new ConnectionLimiter(1000, 1000, 100, 1000)
    expect(limiter.allow('a', 900, 0)).toBe(true)
    expect(limiter.allow('a', 200, 0)).toBe(false)
  })

  it('forgets a closed connection', () => {
    const limiter = new ConnectionLimiter(1, 1, 1000, 1000)
    expect(limiter.allow('a', 1, 0)).toBe(true)
    expect(limiter.allow('a', 1, 0)).toBe(false)
    limiter.forget('a')
    expect(limiter.allow('a', 1, 0)).toBe(true)
  })
})
