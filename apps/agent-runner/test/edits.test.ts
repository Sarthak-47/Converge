import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { replaceRange, revertTurn, TurnRecorder } from '../src/edits.js'
import { Hub } from './hub.js'

const AGENT = 'agent:turn-1'

function client(hub: Hub, gc = true) {
  const doc = new Y.Doc({ gc })
  const disconnect = hub.connect(doc)
  return { doc, text: doc.getText('content'), disconnect }
}

/** Reverts a saved turn the way the runner does after a restart: fresh document, saved state first. */
async function revertFromSavedState(hub: Hub, state: Uint8Array, record: NonNullable<ReturnType<TurnRecorder['record']>>) {
  const doc = new Y.Doc({ gc: false })
  Y.applyUpdate(doc, state)
  const disconnect = hub.connect(doc)
  const reverted = revertTurn(doc.getText('content'), record, 'revert')
  await hub.settle()
  disconnect()
  return reverted
}

describe('replaceRange', () => {
  it('changes only what differs and types insertions in chunks', async () => {
    const hub = new Hub()
    hub.server.getText('content').insert(0, 'const answer = 41\n')
    const agent = client(hub, false)
    const transactions: number[] = []
    agent.doc.on('afterTransaction', (t) => {
      if (t.origin === AGENT) transactions.push(1)
    })

    const before = agent.text.toString()
    await replaceRange(agent.text, before.indexOf('41'), '41', '42 // the real answer', AGENT, { chunk: 4, delayMs: 0 })
    await hub.settle()

    expect(hub.text()).toBe('const answer = 42 // the real answer\n')
    expect(transactions.length).toBeGreaterThan(3) // typed, not pasted
  })
})

describe('reverting a turn (design §13.2)', () => {
  it("keeps a teammate's concurrent and later edits", async () => {
    const hub = new Hub()
    hub.server.getText('content').insert(0, 'function signup(user) {\n  save(user)\n}\n')
    const agent = client(hub, false)
    const ben = client(hub)
    const recorder = new TurnRecorder(agent.text, AGENT)

    // The agent rewrites the body while Ben types a comment above the function.
    const current = agent.text.toString()
    const editing = replaceRange(agent.text, current.indexOf('  save(user)'), '  save(user)',
      '  if (!user.email) throw new Error("email required")\n  save(user)', AGENT, { chunk: 5, delayMs: 1 })
    ben.text.insert(0, '// Ben: keep this short\n')
    await editing
    await hub.settle()
    expect(hub.text()).toContain('email required')
    expect(hub.text()).toContain('// Ben: keep this short')

    const record = recorder.record()!
    const state = Y.encodeStateAsUpdate(agent.doc)
    agent.disconnect()
    ben.text.insert(ben.text.length, '// Ben again, after the turn\n')
    await hub.settle()

    expect(await revertFromSavedState(hub, state, record)).toBe(true)
    expect(hub.text()).toBe('// Ben: keep this short\nfunction signup(user) {\n  save(user)\n}\n// Ben again, after the turn\n')
    expect(ben.text.toString()).toBe(hub.text())
  })

  it('restores text the agent deleted even though the server collected it', async () => {
    const hub = new Hub()
    hub.server.getText('content').insert(0, 'keep\nremove this line\nkeep too\n')
    const agent = client(hub, false)
    const recorder = new TurnRecorder(agent.text, AGENT)
    const current = agent.text.toString()
    await replaceRange(agent.text, current.indexOf('remove this line\n'), 'remove this line\n', '', AGENT, { chunk: 0, delayMs: 0 })
    await hub.settle()
    expect(hub.text()).toBe('keep\nkeep too\n')

    const state = Y.encodeStateAsUpdate(agent.doc)
    agent.disconnect()
    expect(await revertFromSavedState(hub, state, recorder.record()!)).toBe(true)
    expect(hub.text()).toBe('keep\nremove this line\nkeep too\n')
  })

  it('removes exactly the agent text and keeps every teammate character (property)', async () => {
    // Original text is lowercase, the agent writes uppercase, the teammate types digits.
    const lower = fc.string({ unit: fc.constantFrom('a', 'b', 'c', '\n'), minLength: 1, maxLength: 40 })
    const upper = fc.string({ unit: fc.constantFrom('X', 'Y', 'Z'), maxLength: 30 })
    const digits = fc.array(fc.tuple(fc.nat(), fc.string({ unit: fc.constantFrom('1', '2', '3'), minLength: 1, maxLength: 4 })), { maxLength: 6 })
    await fc.assert(
      fc.asyncProperty(lower, fc.nat(), fc.nat(), upper, digits, async (original, a, b, replacement, typed) => {
        const hub = new Hub()
        hub.server.getText('content').insert(0, original)
        const agent = client(hub, false)
        const ben = client(hub)
        const recorder = new TurnRecorder(agent.text, AGENT)
        const start = Math.min(a, b) % (original.length + 1)
        const end = Math.min(original.length, start + (Math.max(a, b) % (original.length + 1)))
        const editing = replaceRange(agent.text, start, original.slice(start, end), replacement, AGENT, { chunk: 2, delayMs: 0 })
        for (const [at, s] of typed) {
          ben.text.insert(at % (ben.text.length + 1), s)
          await Promise.resolve()
        }
        await editing
        await hub.settle()
        const record = recorder.record()
        const state = Y.encodeStateAsUpdate(agent.doc)
        agent.disconnect()
        if (record) await revertFromSavedState(hub, state, record)

        const result = hub.text()
        expect(result).not.toMatch(/[XYZ]/)
        expect(result.replace(/[123]/g, '')).toBe(original)
        expect(result.replace(/[^123]/g, '').length).toBe(typed.reduce((n, [, s]) => n + s.length, 0))
      }),
      { numRuns: 300 },
    )
  }, 60_000)
})
