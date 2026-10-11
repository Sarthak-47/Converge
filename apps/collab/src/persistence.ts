import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import * as Y from 'yjs'

/** The shared type every file's text lives in. The web client binds Monaco to the same name. */
export const TEXT_FIELD = 'content'

export class DocumentNotFoundError extends Error {}

/**
 * Loads a file's live state. Files created before live editing existed have only text, so the first load
 * seeds the Yjs document from it and stores the state at once, so the seed never happens twice.
 */
export async function loadDocument(db: Pool, fileId: string, doc: Y.Doc): Promise<void> {
  const result = await db.query<{ yjs_state: Buffer | null; text_content: string }>(
    `select d.yjs_state, d.text_content
       from documents d join files f on f.id = d.file_id
      where d.file_id = $1 and f.deleted_at is null`,
    [fileId],
  )
  const row = result.rows[0]
  if (!row) throw new DocumentNotFoundError(`No live document for ${fileId}`)
  if (row.yjs_state) {
    Y.applyUpdate(doc, new Uint8Array(row.yjs_state))
    return
  }
  if (row.text_content) {
    doc.transact(() => doc.getText(TEXT_FIELD).insert(0, row.text_content), 'migration')
  }
  await storeDocument(db, fileId, doc)
}

/**
 * Stores the Yjs state and its materialized text (design §6.4). The content version only advances when the
 * text actually changed, so readers can use it to detect stale reads.
 */
export async function storeDocument(db: Pool, fileId: string, doc: Y.Doc): Promise<void> {
  const state = Buffer.from(Y.encodeStateAsUpdate(doc))
  const text = doc.getText(TEXT_FIELD).toString()
  const hash = createHash('sha256').update(text, 'utf8').digest('hex')
  await db.query(
    `update documents
        set yjs_state = $2,
            text_content = $3,
            content_version = content_version + case when content_hash = $4 then 0 else 1 end,
            content_hash = $4,
            updated_at = case when content_hash = $4 then updated_at else now() end,
            state_updated_at = now()
      where file_id = $1`,
    [fileId, state, text, hash],
  )
}
