import { describe, expect, it } from 'vitest'
import { childHeader, fromHeader } from '../src/trace.js'

describe('W3C trace context', () => {
  it('continues a valid trace and starts a new one otherwise', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    expect(fromHeader(`00-${traceId}-00f067aa0ba902b7-01`)).toEqual({ traceId, spanId: '00f067aa0ba902b7' })
    for (const bad of [undefined, '', 'garbage', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, `01-${traceId}-00f067aa0ba902b7-01x`]) {
      expect(fromHeader(bad).traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(fromHeader(bad).traceId).not.toBe(traceId)
    }
  })

  it('passes the same trace on with a new span', () => {
    const context = fromHeader('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    const header = childHeader(context)
    expect(header).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/)
    expect(header).not.toContain('00f067aa0ba902b7')
  })
})
