import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type AgentKey, type AgentProvider } from '../api.ts'

export function dollars(micros: number) {
  return `$${(micros / 1_000_000).toFixed(micros < 10_000 ? 4 : 2)}`
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError || error instanceof Error ? error.message : fallback
}

/**
 * The member's own API keys, one per provider: loaded once, saved encrypted, only a hint shown back
 * (design §13.5). `null` until loaded.
 */
export function useAgentKeys(enabled: boolean) {
  const [keys, setKeys] = useState<AgentKey[] | null>(null)
  const reload = useCallback(() => {
    api.agentKeys().then(setKeys).catch(() => setKeys(null))
  }, [])
  useEffect(() => {
    if (enabled) reload()
  }, [enabled, reload])
  return [keys, reload] as const
}

/** The providers a member can bring a key for, and what their keys look like. */
export const PROVIDERS: Array<{ id: AgentProvider; label: string; placeholder: string }> = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
  { id: 'gemini', label: 'Google Gemini', placeholder: 'AIza…' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…' },
]
