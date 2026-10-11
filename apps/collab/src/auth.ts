import type { onAuthenticatePayload, onConnectPayload } from '@hocuspocus/server'
import { config } from './config.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ConnectionContext = {
  userId: string
  displayName: string
  workspaceId: string
  role: 'OWNER' | 'EDITOR' | 'COMMENTER' | 'VIEWER'
}

type Grant = ConnectionContext & { fileId: string; readOnly: boolean }

export function isFileId(name: string): boolean {
  return UUID.test(name)
}

/** Refuses handshakes from pages on other origins (design §14.3), when an allowlist is configured. */
export async function checkOrigin({ requestHeaders }: onConnectPayload): Promise<void> {
  if (config.allowedOrigins.length === 0) return
  const origin = requestHeaders.get('origin')
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new Error('Origin not allowed')
  }
}

/**
 * Redeems the connection's ticket with the API (design §5.3). Viewers and commenters get read-only
 * connections: the server drops any document update they send.
 */
export async function authenticate(data: onAuthenticatePayload): Promise<ConnectionContext> {
  if (!isFileId(data.documentName)) throw new Error('Unknown document')
  const response = await fetch(`${config.apiUrl}/internal/collab/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.internalToken },
    body: JSON.stringify({ ticket: data.token, documentName: data.documentName }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`Not authorized (${response.status})`)
  const grant = (await response.json()) as Grant
  if (grant.readOnly) data.connectionConfig.readOnly = true
  return { userId: grant.userId, displayName: grant.displayName, workspaceId: grant.workspaceId, role: grant.role }
}
