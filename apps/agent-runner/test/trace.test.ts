import { describe, expect, it } from 'vitest'
import { childHeader, fromHeader } from '../src/trace.js'

describe('W3C trace context', () => {
  it('continues a valid trace in a new span of its own, and starts a new one otherwise', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const context = fromHeader(`00-${traceId}-00f067aa0ba902b7-01`)
    expect(context).toMatchObject({ traceId, parentSpanId: '00f067aa0ba902b7' })
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(context.spanId).not.toBe('00f067aa0ba902b7')
    for (const bad of [undefined, '', 'garbage', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, `01-${traceId}-00f067aa0ba902b7-01x`]) {
      expect(fromHeader(bad).traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(fromHeader(bad).traceId).not.toBe(traceId)
      expect(fromHeader(bad).parentSpanId).toBeUndefined()
    }
  })

  it('passes the same trace on, naming its own span as the next service’s parent', () => {
    const context = fromHeader('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    expect(childHeader(context)).toBe(`00-4bf92f3577b34da6a3ce929d0e0e4736-${context.spanId}-01`)
    expect(childHeader(context)).not.toContain('00f067aa0ba902b7')
  })
})
