import diff from 'fast-diff'
import * as Y from 'yjs'

export type Typing = {
  /** Characters inserted per transaction. */
  chunk: number
  /** Pause between transactions; 0 applies an edit at once. */
  delayMs: number
  /** Called with the agent's caret position after each transaction. */
  onCursor?: (index: number) => void
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Replaces `oldText` at `index` with `newText` as the smallest set of Yjs operations (design §13.2): text
 * both versions share is left alone, deletions happen at once, and insertions are typed in small
 * transactions so people watch the agent write. Insertion points are held as relative positions, so text
 * that teammates type meanwhile shifts them correctly instead of being overwritten.
 *
 * The caller must have read `oldText` at `index` in the same synchronous tick, before any await.
 */
export async function replaceRange(
  text: Y.Text,
  index: number,
  oldText: string,
  newText: string,
  origin: unknown,
  typing: Typing,
): Promise<void> {
  const doc = text.doc!
  const deletions: Array<[number, number]> = []
  const insertions: Array<{ at: Y.RelativePosition; text: string }> = []
  let position = index
  for (const [op, part] of diff(oldText, newText)) {
    if (op === diff.EQUAL) {
      position += part.length
    } else if (op === diff.DELETE) {
      deletions.push([position, part.length])
      position += part.length
    } else {
      // Anchored to the character after the insertion point (or the end of the text), so typing in chunks
      // keeps each chunk after the previous one and before whatever followed.
      insertions.push({ at: Y.createRelativePositionFromTypeIndex(text, position, 0), text: part })
    }
  }

  if (deletions.length > 0) {
    doc.transact(() => {
      for (const [at, length] of deletions.reverse()) text.delete(at, length)
    }, origin)
  }

  const chunkSize = typing.chunk > 0 ? typing.chunk : Number.POSITIVE_INFINITY
  for (const insertion of insertions) {
    // Long insertions are typed in at most ~100 steps, so large edits still finish in a few seconds.
    const size = Math.max(chunkSize, Math.ceil(insertion.text.length / 100))
    for (let offset = 0; offset < insertion.text.length; offset += size) {
      const piece = insertion.text.slice(offset, offset + size)
      let caret = 0
      doc.transact(() => {
        const at = Y.createAbsolutePositionFromRelativePosition(insertion.at, doc)?.index ?? text.length
        text.insert(at, piece)
        caret = at + piece.length
      }, origin)
      typing.onCursor?.(caret)
      if (typing.delayMs > 0) await pause(typing.delayMs)
    }
  }
}

/** One turn's changes to one document: what it inserted and what it deleted, as Yjs ID ranges. */
export type UndoRecord = {
  insertions: Record<string, Array<[number, number]>>
  deletions: Record<string, Array<[number, number]>>
}

type DeleteSetLike = { clients: Map<number, Array<{ clock: number; len: number }>> }

function encodeRanges(set: DeleteSetLike): Record<string, Array<[number, number]>> {
  const out: Record<string, Array<[number, number]>> = {}
  set.clients.forEach((items, client) => {
    if (items.length > 0) out[String(client)] = items.map((item) => [item.clock, item.len])
  })
  return out
}

function decodeRanges(ranges: Record<string, Array<[number, number]>>): DeleteSetLike {
  const set = Y.createDeleteSet() as unknown as DeleteSetLike
  for (const [client, items] of Object.entries(ranges)) {
    const sorted = [...items].sort((a, b) => a[0] - b[0]).map(([clock, len]) => ({ clock, len }))
    set.clients.set(Number(client), sorted)
  }
  return set
}

/**
 * Records everything one origin does to a text, for reverting it later even after the runner restarts
 * (design §13.2). Uses an UndoManager that never splits its capture, so a whole turn is one stack item.
 */
export class TurnRecorder {
  private readonly undo: Y.UndoManager

  constructor(text: Y.Text, origin: unknown) {
    this.undo = new Y.UndoManager(text, {
      trackedOrigins: new Set([origin]),
      captureTimeout: Number.POSITIVE_INFINITY,
    })
  }

  /** The turn's changes, or null if it changed nothing. */
  record(): UndoRecord | null {
    const item = this.undo.undoStack[0] as unknown as { insertions: DeleteSetLike; deletions: DeleteSetLike } | undefined
    if (!item) return null
    return { insertions: encodeRanges(item.insertions), deletions: encodeRanges(item.deletions) }
  }

  destroy() {
    this.undo.destroy()
  }
}

/**
 * Reverts one recorded turn: removes what it inserted and restores what it deleted, leaving every other
 * edit in place. `text` must belong to a document that was loaded from the turn's saved state (so the
 * deleted content exists) and is then synced with the live document.
 */
export function revertTurn(text: Y.Text, record: UndoRecord, origin: unknown): boolean {
  const manager = new Y.UndoManager(text, { trackedOrigins: new Set([origin]) })
  try {
    // An UndoManager only reads `insertions`, `deletions` and `meta` from a stack item.
    manager.undoStack.push({
      insertions: decodeRanges(record.insertions),
      deletions: decodeRanges(record.deletions),
      meta: new Map(),
    } as unknown as (typeof manager.undoStack)[number])
    return manager.undo() !== null
  } finally {
    manager.destroy()
  }
}
