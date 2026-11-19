import { useEffect, useState } from 'react'
import { api, ApiError, type AgentKey } from '../api.ts'

export function dollars(micros: number) {
  return `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback
}

/** The member's own API key status: loaded once, saved encrypted, only a hint shown back (design §13.5). */
export function useAgentKey(enabled: boolean) {
  const [key, setKey] = useState<AgentKey | null>(null)
  useEffect(() => {
    if (enabled) api.agentKey().then(setKey).catch(() => setKey(null))
  }, [enabled])
  return [key, setKey] as const
}
