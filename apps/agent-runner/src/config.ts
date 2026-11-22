function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

function number(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`)
  return value
}

export const config = {
  port: number('RUNNER_PORT', 4100),
  /** Base URL of the API, for the turn's internal calls (design §5.3). */
  apiUrl: required('API_URL', 'http://localhost:8080'),
  /** The collaboration service's WebSocket endpoint; agents join documents there as their own Yjs clients. */
  collabUrl: required('COLLAB_WS_URL', 'ws://localhost:1234'),
  /** Origin presented on the collaboration handshake; must be in the collaboration service's allowlist. */
  collabOrigin: required('COLLAB_ORIGIN', 'http://localhost:8000'),
  /** Shared secret for /internal calls in both directions; empty refuses all of them. */
  internalToken: process.env.INTERNAL_TOKEN ?? '',
  /**
   * Where model requests go, for every provider. Unset means each provider's real API; tests and the
   * end-to-end stack point it at the scripted fake model so no key or money is needed. ANTHROPIC_BASE_URL is
   * the older name.
   */
  modelBaseUrl: process.env.MODEL_BASE_URL || process.env.ANTHROPIC_BASE_URL || undefined,
  /** Server-side refusal fallback (design §13.4); off only for gateways that reject the beta parameter. */
  fallbacks: (process.env.AGENT_FALLBACKS ?? 'true') !== 'false',
  /** Characters typed per Yjs transaction and the pause between them, so people see the agent type. */
  typingChunk: number('AGENT_TYPING_CHUNK', 24),
  typingDelayMs: number('AGENT_TYPING_DELAY_MS', 25),
}
