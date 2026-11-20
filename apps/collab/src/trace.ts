import { randomBytes } from 'node:crypto'

/**
 * W3C trace context (design §16.3), without an OpenTelemetry SDK: enough to continue the API's trace across
 * this service, put its trace ID in every log line, and pass it on to the next call. The same tiny helper
 * lives in each Node service.
 */
export type TraceContext = { traceId: string; spanId: string }

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/

/** The caller's trace, or a new one when the request carried none (or an invalid one). */
export function fromHeader(header: string | string[] | undefined | null): TraceContext {
  const value = Array.isArray(header) ? header[0] : header
  const match = value ? TRACEPARENT.exec(value.trim()) : null
  if (match && !/^0+$/.test(match[1]!)) return { traceId: match[1]!, spanId: match[2]! }
  return { traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex') }
}

/** A traceparent for an outgoing call: same trace, a new span, sampled. */
export function childHeader(context: TraceContext): string {
  return `00-${context.traceId}-${randomBytes(8).toString('hex')}-01`
}
