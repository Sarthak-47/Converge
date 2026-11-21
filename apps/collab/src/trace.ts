import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * W3C trace context (design §16.3), without an OpenTelemetry SDK: enough to continue the API's trace across
 * this service, put its trace ID in every log line, and pass it on to the next call. When
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, finished spans are also sent to that collector or tracing backend
 * over OTLP/HTTP with JSON bodies, in batches, and dropped rather than queued without bound when it is
 * down. The same small helper lives in each Node service.
 */
export type TraceContext = {
  traceId: string
  /** This service's own span: the parent named in every call it makes. */
  spanId: string
  /** The caller's span, when there was one. */
  parentSpanId?: string
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/
const id = (bytes: number) => randomBytes(bytes).toString('hex')

/** Continues the caller's trace in a new span of this service, or starts a trace without one. */
export function fromHeader(header: string | string[] | undefined | null): TraceContext {
  const value = Array.isArray(header) ? header[0] : header
  const match = value ? TRACEPARENT.exec(value.trim()) : null
  if (match && !/^0+$/.test(match[1]!)) {
    return { traceId: match[1]!, spanId: id(8), ...(/^0+$/.test(match[2]!) ? {} : { parentSpanId: match[2]! }) }
  }
  return { traceId: id(16), spanId: id(8) }
}

/** A traceparent for an outgoing call: the same trace, with this span as the callee's parent. */
export function childHeader(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-01`
}

/** A new span inside another one (or a new trace when there is none). */
export function childOf(parent: TraceContext | undefined): TraceContext {
  return parent ? { traceId: parent.traceId, spanId: id(8), parentSpanId: parent.spanId } : { traceId: id(16), spanId: id(8) }
}

type Attribute = string | number | boolean | undefined
type Span = {
  context: TraceContext
  name: string
  kind: number
  start: number
  end: number
  error: boolean
  attributes: Record<string, Attribute>
}

export const SPAN_KIND = { internal: 1, server: 2 } as const

const MAX_QUEUED = 4096
const MAX_BATCH = 512
let exporter: { url: string; service: string; queue: Span[]; dropped: number; timer: NodeJS.Timeout } | null = null

/**
 * Turns export on when an endpoint is configured (OTEL_EXPORTER_OTLP_ENDPOINT, and OTEL_SERVICE_NAME or the
 * given default for the service's name). Does nothing otherwise.
 */
export function startSpanExport(defaultService: string, env: NodeJS.ProcessEnv = process.env, flushMs = 2000) {
  stopSpanExport()
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (!endpoint) return false
  const base = endpoint.replace(/\/+$/, '')
  exporter = {
    url: base.endsWith('/v1/traces') ? base : `${base}/v1/traces`,
    service: env.OTEL_SERVICE_NAME?.trim() || defaultService,
    queue: [],
    dropped: 0,
    timer: setInterval(() => void flushSpans(), flushMs),
  }
  exporter.timer.unref()
  return true
}

export function stopSpanExport() {
  if (exporter) clearInterval(exporter.timer)
  exporter = null
}

export function spanExportEnabled() {
  return exporter !== null
}

/** Records a finished span if export is on. Never throws, never waits. */
export function recordSpan(span: Span) {
  if (!exporter) return
  if (exporter.queue.length >= MAX_QUEUED) {
    exporter.dropped++
    return
  }
  exporter.queue.push(span)
  if (exporter.queue.length >= MAX_BATCH) void flushSpans()
}

/** Runs work as its own span, recorded when it settles; a thrown error marks the span failed. */
export async function inSpan<T>(name: string, parent: TraceContext | undefined, work: (context: TraceContext) => Promise<T>,
  attributes: Record<string, Attribute> = {}): Promise<T> {
  const context = childOf(parent)
  const start = Date.now()
  let error = false
  try {
    return await work(context)
  } catch (thrown) {
    error = true
    throw thrown
  } finally {
    recordSpan({ context, name, kind: SPAN_KIND.internal, start, end: Date.now(), error, attributes })
  }
}

/** A request path with ids replaced, so spans for the same route share one name. */
export function route(path: string): string {
  return path.split('?')[0]!.replace(/(?<=\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)(?=\/|$)/gi, '{id}')
}

/** Continues the caller's trace for an incoming request, and records it as a server span when it ends. */
export function traceRequest(request: IncomingMessage, response: ServerResponse): TraceContext {
  const context = fromHeader(request.headers.traceparent)
  const start = Date.now()
  response.once('close', () => {
    const name = `${request.method ?? 'GET'} ${route(request.url ?? '/')}`
    recordSpan({
      context, name, kind: SPAN_KIND.server, start, end: Date.now(), error: response.statusCode >= 500,
      attributes: { 'http.request.method': request.method, 'http.route': route(request.url ?? '/'), 'http.response.status_code': response.statusCode },
    })
  })
  return context
}

/** Sends everything queued so far. */
export async function flushSpans() {
  const target = exporter
  if (!target) return
  if (target.dropped > 0) {
    console.warn(JSON.stringify({ level: 'WARN', event: 'SPANS_DROPPED', count: target.dropped }))
    target.dropped = 0
  }
  while (target.queue.length > 0) {
    const batch = target.queue.splice(0, MAX_BATCH)
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(otlpPayload(target.service, batch)),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) console.warn(JSON.stringify({ level: 'WARN', event: 'SPAN_EXPORT_REFUSED', status: response.status, spans: batch.length }))
    } catch (error) {
      console.warn(JSON.stringify({ level: 'WARN', event: 'SPAN_EXPORT_FAILED', spans: batch.length, message: (error as Error).message }))
    }
  }
}

const nanos = (ms: number) => (BigInt(ms) * 1_000_000n).toString()

function attributeList(values: Record<string, Attribute>) {
  return Object.entries(values).filter(([, v]) => v !== undefined).map(([key, value]) => ({
    key,
    value: typeof value === 'number' ? { intValue: String(Math.trunc(value)) }
      : typeof value === 'boolean' ? { boolValue: value } : { stringValue: String(value) },
  }))
}

/** The OTLP/JSON request body: one resource (this service), one scope, the spans. */
export function otlpPayload(service: string, spans: Span[]) {
  return {
    resourceSpans: [{
      resource: { attributes: attributeList({ 'service.name': service }) },
      scopeSpans: [{
        scope: { name: 'converge' },
        spans: spans.map((span) => ({
          traceId: span.context.traceId,
          spanId: span.context.spanId,
          ...(span.context.parentSpanId ? { parentSpanId: span.context.parentSpanId } : {}),
          name: span.name,
          kind: span.kind,
          startTimeUnixNano: nanos(span.start),
          endTimeUnixNano: nanos(span.end),
          attributes: attributeList(span.attributes),
          status: { code: span.error ? 2 : 1 },
        })),
      }],
    }],
  }
}
