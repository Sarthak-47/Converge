import { createHash } from 'node:crypto'
import diff from 'fast-diff'
import type * as Y from 'yjs'

/** Same limit as the server (design §12.7): larger files are left to Git. */
export const MAX_SYNC_BYTES = 1_000_000

export type Eol = '\n' | '\r\n'

/** Live documents always hold LF; each checkout keeps the line endings its files already use. */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

export function withEol(text: string, eol: Eol): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A NUL byte in the first 8 KB is the same heuristic Git uses to call a file binary. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0)
}

/**
 * Turns `ytext` into `target` with the smallest set of character edits, so concurrent edits in untouched
 * regions survive (design §8.9). The same algorithm the collaboration service uses for external changes.
 * Call inside a transaction. Returns true when anything changed.
 */
export function applyTextChange(ytext: Y.Text, target: string): boolean {
  const current = ytext.toString()
  if (current === target) return false
  let index = 0
  for (const [operation, chunk] of diff(current, target)) {
    if (operation === diff.EQUAL) {
      index += chunk.length
    } else if (operation === diff.DELETE) {
      ytext.delete(index, chunk.length)
    } else {
      ytext.insert(index, chunk)
      index += chunk.length
    }
  }
  return true
}
