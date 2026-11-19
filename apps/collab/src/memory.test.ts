import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { evaluate, similarity, type StoredMemory } from './memory.js'

function docWith(text: string) {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return doc
}

/** A note on `quote`, anchored the way the browser and runner anchor it. */
function note(doc: Y.Doc, quote: string): StoredMemory {
  const text = doc.getText('content')
  const start = text.toString().indexOf(quote)
  return {
    id: 'n1',
    anchor: {
      start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, start, 0)),
      end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, start + quote.length, -1)),
    },
    anchoredText: quote,
    currentText: quote,
    status: 'ACTIVE',
  }
}

describe('similarity', () => {
  it('is 1 for identical text and falls as text is rewritten', () => {
    expect(similarity('const a = 1', 'const a = 1')).toBe(1)
    expect(similarity('const answer = 42', 'const answer = 43')).toBeGreaterThan(0.9)
    expect(similarity('const answer = 42', 'return fetchAnswer()')).toBeLessThan(0.6)
  })
})

describe('re-checking notes (design §13.10)', () => {
  it('follows its code through edits elsewhere and reports nothing new', () => {
    const doc = docWith('function a() {}\nconst limit = 10\n')
    const memory = note(doc, 'const limit = 10')
    doc.getText('content').insert(0, '// header added above\n')
    expect(evaluate([memory], doc)).toEqual([])
  })

  it('stays current through small edits inside the code', () => {
    const doc = docWith('const retryLimit = 10\n')
    const memory = note(doc, 'const retryLimit = 10')
    const text = doc.getText('content')
    text.insert(text.toString().indexOf('Limit'), 'Count')
    expect(evaluate([memory], doc)).toEqual([{ id: 'n1', currentText: 'const retryCountLimit = 10', similarity: expect.any(Number), status: 'ACTIVE' }])
  })

  it('covers only the original range: text typed just after it does not join the note', () => {
    const doc = docWith('const retryLimit = 10\n')
    const memory = note(doc, 'const retryLimit = 10')
    const text = doc.getText('content')
    text.insert('const retryLimit = 10'.length, ' // tuned')
    expect(evaluate([memory], doc)).toEqual([])
  })

  it('is flagged when its code is rewritten', () => {
    const doc = docWith('const retryLimit = 10\nnext()\n')
    const memory = note(doc, 'const retryLimit = 10')
    const text = doc.getText('content')
    // Replace everything between the anchors (keeping the first and last characters, which hold the anchors).
    text.delete(1, 'const retryLimit = 10'.length - 2)
    text.insert(1, 'onfig.load()')
    const [check] = evaluate([memory], doc)
    expect(check?.status).toBe('STALE')
    expect(check?.currentText).toBe('config.load()0')
  })

  it('is flagged when its code is deleted, and current again when it comes back', () => {
    const doc = docWith('keep\nconst retryLimit = 10\nkeep\n')
    const memory = note(doc, 'const retryLimit = 10')
    const undo = new Y.UndoManager(doc.getText('content'))
    const text = doc.getText('content')
    text.delete(text.toString().indexOf('const'), 'const retryLimit = 10\n'.length)
    const [deleted] = evaluate([memory], doc)
    expect(deleted).toMatchObject({ status: 'STALE', currentText: null })

    // An undo restores the same code, and the anchors follow it back (Yjs tracks redone content).
    undo.undo()
    const stale = { ...memory, status: 'STALE' as const, currentText: null }
    expect(evaluate([stale], doc)).toEqual([{ id: 'n1', currentText: 'const retryLimit = 10', similarity: 1, status: 'ACTIVE' }])
  })
})
