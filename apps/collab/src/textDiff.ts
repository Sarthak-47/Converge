import diff from 'fast-diff'
import type * as Y from 'yjs'

/**
 * Turns `ytext` into `target` with the smallest set of character inserts and deletes (design §8.9).
 * Unchanged regions are not touched, so anything typed concurrently into them survives the merge; this is
 * what makes restores, formatters and API writes safe while people are editing.
 *
 * Call inside a Yjs transaction so the whole change arrives at other clients as one update.
 * Returns true when the text changed.
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
