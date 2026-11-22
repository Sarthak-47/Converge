/**
 * Prices in micro-dollars per token, which is the same number as dollars per million tokens. Cache writes are
 * the five-minute rate (1.25 × input).
 *
 * Models on other providers are named "<provider>:<model>". Their prices change often, so none are built
 * in: an operator lists the ones they allow in AGENT_MODEL_PRICES (JSON, the same shape as below), and any
 * model without a price is charged at a deliberately high rate, so a cost cap is never under-enforced.
 * OpenRouter reports each request's real price, which is used instead.
 */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
}
/** For models without a known price: above any current flagship's list price. */
const UNKNOWN: Price = { input: 15, output: 75, cacheRead: 15, cacheWrite: 15 }

function configured(raw: string | undefined): Record<string, Price> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<Price>>
    const out: Record<string, Price> = {}
    for (const [model, p] of Object.entries(parsed)) {
      if (typeof p?.input !== 'number' || typeof p.output !== 'number') continue
      out[model] = { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input, cacheWrite: p.cacheWrite ?? p.input }
    }
    return out
  } catch {
    console.error(JSON.stringify({ level: 'ERROR', event: 'MODEL_PRICES_INVALID', message: 'AGENT_MODEL_PRICES is not valid JSON; using defaults' }))
    return {}
  }
}

const EXTRA = configured(process.env.AGENT_MODEL_PRICES)

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The price for a model; a provider may answer with a dated name ("gpt-x-2026-05-01"), so prefixes match. */
function priceOf(model: string): Price {
  const exact = EXTRA[model] ?? PRICES[model]
  if (exact) return exact
  const prefix = Object.keys({ ...PRICES, ...EXTRA })
    .filter((known) => model.startsWith(`${known}-`))
    .sort((a, b) => b.length - a.length)[0]
  return prefix ? (EXTRA[prefix] ?? PRICES[prefix])! : UNKNOWN
}

/** Cost of one model response in micro-dollars, rounded up. */
export function costMicros(model: string, usage: Usage): number {
  const price = priceOf(model)
  return Math.ceil(
    usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite,
  )
}
