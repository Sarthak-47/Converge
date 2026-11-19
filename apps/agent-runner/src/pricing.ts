/**
 * Prices in micro-dollars per token, which is the same number as dollars per million tokens. Cache writes are
 * the five-minute rate (1.25 × input). Unknown models are charged at the most expensive known rate, so a cost
 * cap is never under-enforced.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
}
const MOST_EXPENSIVE = PRICES['claude-opus-5']!

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Cost of one model response in micro-dollars, rounded up. */
export function costMicros(model: string, usage: Usage): number {
  const price = PRICES[model] ?? MOST_EXPENSIVE
  return Math.ceil(
    usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite,
  )
}
