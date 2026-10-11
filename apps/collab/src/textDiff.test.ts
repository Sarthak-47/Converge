import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyTextChange } from './textDiff.js'

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return doc
}

/** A second replica that starts from exactly the same state, as a reconnecting client would. */
function replicaOf(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

function exchange(a: Y.Doc, b: Y.Doc) {
  const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
  const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
  Y.applyUpdate(b, fromA)
  Y.applyUpdate(a, fromB)
}

const text = (doc: Y.Doc) => doc.getText('content').toString()

describe('applyTextChange', () => {
  it('produces exactly the target text for any pair of strings', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (before, after) => {
        const doc = docWith(before)
        doc.transact(() => applyTextChange(doc.getText('content'), after))
        expect(text(doc)).toBe(after)
      }),
    )
  })

  it('reports whether anything changed', () => {
    const doc = docWith('same')
    expect(applyTextChange(doc.getText('content'), 'same')).toBe(false)
    expect(applyTextChange(doc.getText('content'), 'different')).toBe(true)
  })

  it('keeps a concurrent edit made in a region the change does not touch', () => {
    const server = docWith('hello world')
    const client = replicaOf(server)

    // A restore rewrites the first word while a person is typing at the end of the line.
    server.transact(() => applyTextChange(server.getText('content'), 'HELLO world'))
    client.getText('content').insert('hello world'.length, '!!')
    exchange(server, client)

    expect(text(server)).toBe('HELLO world!!')
    expect(text(client)).toBe(text(server))
  })

  it('never makes replicas diverge, whatever the concurrent edits', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.nat(),
        fc.string({ minLength: 1 }),
        (base, target, position, typed) => {
          const server = docWith(base)
          const client = replicaOf(server)
          server.transact(() => applyTextChange(server.getText('content'), target))
          client.getText('content').insert(position % (base.length + 1), typed)
          exchange(server, client)
          expect(text(client)).toBe(text(server))
          expect(text(server)).toContain(typed)
        },
      ),
    )
  })
})
