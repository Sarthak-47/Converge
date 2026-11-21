import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { childHeader, flushSpans, fromHeader, inSpan, route, spanExportEnabled, startSpanExport, stopSpanExport } from './trace.js'

afterEach(() => stopSpanExport())

describe('trace context', () => {
  it('continues the caller in a new span, and names that span as the parent of its own calls', () => {
    const own = fromHeader('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')
    expect(own.traceId).toBe('0af7651916cd43dd8448eb211c80319c')
    expect(own.parentSpanId).toBe('b7ad6b7169203331')
    expect(own.spanId).not.toBe('b7ad6b7169203331')
    expect(childHeader(own)).toBe(`00-0af7651916cd43dd8448eb211c80319c-${own.spanId}-01`)
    expect(fromHeader('nonsense').parentSpanId).toBeUndefined()
  })

  it('names routes with their ids replaced', () => {
    expect(route('/internal/files/0b4d5c1e-1111-4a2b-9c3d-0123456789ab/apply-text?x=1')).toBe('/internal/files/{id}/apply-text')
    expect(route('/v1/turns/42')).toBe('/v1/turns/{id}')
  })
})

describe('span export', () => {
  it('stays off without an endpoint', () => {
    expect(startSpanExport('converge-collab', {})).toBe(false)
    expect(spanExportEnabled()).toBe(false)
  })

  it('sends finished spans as OTLP JSON, parent first in the same trace', async () => {
    const bodies: Array<{ path: string; body: any }> = []
    const collector = createServer((request, response) => {
      let text = ''
      request.on('data', (chunk) => (text += chunk))
      request.on('end', () => {
        bodies.push({ path: request.url ?? '', body: JSON.parse(text) })
        response.writeHead(200).end()
      })
    })
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve))
    try {
      const port = (collector.address() as AddressInfo).port
      expect(startSpanExport('converge-collab', { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}/`, OTEL_SERVICE_NAME: 'collab-test' }, 60_000)).toBe(true)
      await inSpan('outer', undefined, (outer) => inSpan('inner', outer, async () => 'done', { n: 3 }))
      await expect(inSpan('broken', undefined, async () => { throw new Error('no') })).rejects.toThrow('no')
      await flushSpans()

      expect(bodies.map((b) => b.path)).toEqual(['/v1/traces'])
      const resource = bodies[0]!.body.resourceSpans[0]
      expect(resource.resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'collab-test' } }])
      const spans = resource.scopeSpans[0].spans as Array<Record<string, any>>
      const inner = spans.find((s) => s.name === 'inner')!
      const outer = spans.find((s) => s.name === 'outer')!
      expect(inner.traceId).toBe(outer.traceId)
      expect(inner.parentSpanId).toBe(outer.spanId)
      expect(outer.parentSpanId).toBeUndefined()
      expect(inner.attributes).toEqual([{ key: 'n', value: { intValue: '3' } }])
      expect(BigInt(inner.endTimeUnixNano) >= BigInt(inner.startTimeUnixNano)).toBe(true)
      expect(spans.find((s) => s.name === 'broken')!.status).toEqual({ code: 2 })
    } finally {
      collector.close()
    }
  })
})

describe('the shared helper', () => {
  it('is the same file in every Node service', async () => {
    const { readFile } = await import('node:fs/promises')
    const here = await readFile(new URL('./trace.ts', import.meta.url), 'utf8')
    for (const service of ['agent-runner', 'executor']) {
      const copy = await readFile(new URL(`../../${service}/src/trace.ts`, import.meta.url), 'utf8')
      expect(copy.replace(/\r\n/g, '\n'), `apps/${service}/src/trace.ts differs from apps/collab/src/trace.ts`).toBe(here.replace(/\r\n/g, '\n'))
    }
  })
})
