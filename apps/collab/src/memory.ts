import diff from 'fast-diff'
import type { Pool } from 'pg'
import * as Y from 'yjs'
import { TEXT_FIELD } from './persistence.js'

/** A note's state as stored, for re-checking against the document. */
export type StoredMemory = {
  id: string
  anchor: { start: unknown; end: unknown }
  anchoredText: string
  currentText: string | null
  status: 'ACTIVE' | 'STALE'
}

export type MemoryCheck = { id: string; currentText: string | null; similarity: number; status: 'ACTIVE' | 'STALE' }

/** Below this similarity to the text it was written about, a note is considered rewritten (design §13.10). */
export const STALE_BELOW = 0.6

/** Share of characters two texts have in common, from 0 (nothing) to 1 (identical). */
export function similarity(a: string, b: string): number {
  if (a.length + b.length === 0) return 1
  let same = 0
  for (const [op, part] of diff(a, b)) if (op === diff.EQUAL) same += part.length
  return (2 * same) / (a.length + b.length)
}

function resolve(position: unknown, doc: Y.Doc): number | null {
  try {
    return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position), doc)?.index ?? null
  } catch {
    return null
  }
}

/**
 * Re-checks notes against a document: the anchors follow the code through every edit, so whatever they span
 * now is compared with the text the note was written about. Deleted or substantially rewritten code makes the
 * note STALE; code that comes back (an undo, a revert) makes it current again. Returns only notes whose
 * status or anchored text changed.
 */
export function evaluate(notes: StoredMemory[], doc: Y.Doc): MemoryCheck[] {
  const text = doc.getText(TEXT_FIELD).toString()
  const checks: MemoryCheck[] = []
  for (const note of notes) {
    const start = resolve(note.anchor?.start, doc)
    const end = resolve(note.anchor?.end, doc)
    const current = start === null || end === null || end <= start ? null : text.slice(start, end)
    const score = current === null ? 0 : similarity(note.anchoredText, current)
    const status = score >= STALE_BELOW ? 'ACTIVE' : 'STALE'
    if (status !== note.status || current !== note.currentText) {
      checks.push({ id: note.id, currentText: current, similarity: Math.round(score * 1000) / 1000, status })
    }
  }
  return checks
}

/** Loads a file's live notes, re-checks them and reports changes to the API, which notifies the workspace. */
export async function checkMemories(
  db: Pool,
  fileId: string,
  doc: Y.Doc,
  report: (checks: MemoryCheck[]) => Promise<void>,
): Promise<number> {
  const { rows } = await db.query<{ id: string; anchor: StoredMemory['anchor']; anchored_text: string; current_text: string | null; status: 'ACTIVE' | 'STALE' }>(
    `select id, anchor, anchored_text, current_text, status from memories where file_id = $1 and status <> 'RETIRED'`,
    [fileId],
  )
  if (rows.length === 0) return 0
  const checks = evaluate(
    rows.map((r) => ({ id: r.id, anchor: r.anchor, anchoredText: r.anchored_text, currentText: r.current_text, status: r.status })),
    doc,
  )
  if (checks.length > 0) await report(checks)
  return checks.length
}
