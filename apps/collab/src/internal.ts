import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Hocuspocus } from '@hocuspocus/server'
import type { Pool } from 'pg'
import { isFileId } from './auth.js'
import { config } from './config.js'
import { DocumentNotFoundError, storeDocument, TEXT_FIELD } from './persistence.js'
import { REVOKE_ACTIONS, revokeConnections, type LiveConnection, type RevokeAction } from './revoke.js'
import { applyTextChange } from './textDiff.js'

const ROUTE = /^\/internal\/documents\/([^/]+)\/(apply-text|flush)$/
const REVOKE_ROUTE = '/internal/connections/revoke'
const MAX_BODY_BYTES = 4 * 1024 * 1024

function tokenMatches(presented: string | undefined): boolean {
  const expected = Buffer.from(config.internalToken)
  const actual = Buffer.from(presented ?? '')
  return expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new RangeError('Body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Writes a JSON response; returns true so handlers can `return reply(...)` to signal "handled". */
function reply(response: ServerResponse, status: number, body: object): true {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
  return true
}

/**
 * The collaboration side of the service boundary (design §5.3). Returns true when the request was an
 * internal call and has been answered.
 */
export async function handleInternal(
  request: IncomingMessage,
  response: ServerResponse,
  hocuspocus: Hocuspocus,
  db: Pool,
): Promise<boolean> {
  const match = ROUTE.exec(request.url ?? '')
  const isRevoke = request.url === REVOKE_ROUTE
  if (!match && !isRevoke) return false
  if (request.method !== 'POST') return reply(response, 405, { error: 'Method not allowed' })
  if (!tokenMatches(request.headers['x-internal-token'] as string | undefined)) {
    return reply(response, 401, { error: 'Unauthorized' })
  }
  if (isRevoke) return revoke(request, response, hocuspocus)
  if (!match) return false
  const [, fileId, action] = match
  if (!isFileId(fileId)) return reply(response, 404, { error: 'Unknown document' })

  try {
    if (action === 'flush') {
      const document = hocuspocus.documents.get(fileId)
      if (document) await storeDocument(db, fileId, document)
      return reply(response, 200, { stored: Boolean(document) })
    }

    const body = (await readJson(request)) as { text?: unknown; origin?: unknown }
    if (typeof body.text !== 'string') return reply(response, 400, { error: 'text is required' })
    const target = body.text
    const connection = await hocuspocus.openDirectConnection(fileId, { system: true, origin: String(body.origin ?? 'api') })
    let changed = false
    try {
      await connection.transact((document) => {
        changed = applyTextChange(document.getText(TEXT_FIELD), target)
      })
      const document = hocuspocus.documents.get(fileId)
      if (document) await storeDocument(db, fileId, document)
    } finally {
      await connection.disconnect()
    }
    return reply(response, 200, { changed })
  } catch (error) {
    if (error instanceof DocumentNotFoundError) return reply(response, 404, { error: 'Unknown document' })
    if (error instanceof RangeError || error instanceof SyntaxError) return reply(response, 400, { error: error.message })
    throw error
  }
}

/** Applies a workspace role change to the person's open document connections (design §5.3, FR-18). */
async function revoke(request: IncomingMessage, response: ServerResponse, hocuspocus: Hocuspocus): Promise<true> {
  const body = (await readJson(request).catch(() => ({}))) as { userId?: unknown; workspaceId?: unknown; action?: unknown }
  if (typeof body.userId !== 'string' || typeof body.workspaceId !== 'string' || !REVOKE_ACTIONS.includes(body.action as RevokeAction)) {
    return reply(response, 400, { error: 'userId, workspaceId and a valid action are required' })
  }
  const connections: LiveConnection[] = []
  for (const document of hocuspocus.documents.values()) {
    for (const connection of document.connections.keys()) connections.push(connection as unknown as LiveConnection)
  }
  const affected = revokeConnections(connections, body.userId, body.workspaceId, body.action as RevokeAction)
  return reply(response, 200, { affected })
}
