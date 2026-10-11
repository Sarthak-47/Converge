import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SyncBridge } from '../src/bridge.js'
import { MemoryServer } from './memoryRemote.js'

const SCRATCH = path.resolve(import.meta.dirname, '../../../.tmp/sync-tests')

type Step =
  | { kind: 'local'; machine: 0 | 1; position: number; insert: string }
  | { kind: 'remote'; position: number; insert: string }
  | { kind: 'toggle-offline'; machine: 0 | 1 }

const insertText = fc.stringMatching(/^[a-z ]{1,6}$/)
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant('local' as const), machine: fc.constantFrom(0 as const, 1 as const), position: fc.nat(), insert: insertText }),
  fc.record({ kind: fc.constant('remote' as const), position: fc.nat(), insert: insertText }),
  fc.record({ kind: fc.constant('toggle-offline' as const), machine: fc.constantFrom(0 as const, 1 as const) }),
)

/**
 * Design §22.8: random interleavings of local writes on two machines, remote edits and connection loss
 * always end with both checkouts and the workspace holding identical text.
 */
describe('convergence', () => {
  it('two checkouts and the workspace always end identical', { timeout: 120_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
        const server = new MemoryServer()
        const id = server.addFile('doc.txt', 'start\n')
        const roots = [0, 1].map((i) => path.join(SCRATCH, `prop-${i}-${Math.random().toString(36).slice(2)}`))
        const clients = roots.map(() => server.connect())
        const bridges = roots.map((root, i) => new SyncBridge({ root, remote: clients[i], watch: false }))
        try {
          for (const root of roots) await mkdir(root, { recursive: true })
          for (const bridge of bridges) await bridge.start()
          await Promise.all(bridges.map((b) => b.idle()))

          for (const s of steps) {
            if (s.kind === 'remote') {
              server.edit(id, (t) => t.insert(s.position % (t.length + 1), s.insert))
            } else if (s.kind === 'toggle-offline') {
              const client = clients[s.machine]
              if (client.offline) client.goOnline()
              else client.goOffline()
            } else {
              const file = path.join(roots[s.machine], 'doc.txt')
              const current = await readFile(file, 'utf8')
              const at = s.position % (current.length + 1)
              await writeFile(file, current.slice(0, at) + s.insert + current.slice(at))
              await bridges[s.machine].diskChanged('doc.txt')
            }
            await Promise.all(bridges.map((b) => b.idle()))
          }

          clients.forEach((c) => c.goOnline())
          for (let round = 0; round < 4; round++) {
            await new Promise((resolve) => setTimeout(resolve, 5))
            await Promise.all(bridges.map((b) => b.idle()))
          }

          const expected = server.text(id)
          for (const root of roots) expect(await readFile(path.join(root, 'doc.txt'), 'utf8')).toBe(expected)
        } finally {
          await Promise.all(bridges.map((b) => b.stop()))
          await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
        }
      }),
      { numRuns: 40 },
    )
  })
})

describe('file watching', () => {
  it('notices an ordinary save through the real file watcher', { timeout: 30_000 }, async () => {
    const server = new MemoryServer()
    const id = server.addFile('watched.txt', 'before')
    const root = path.join(SCRATCH, `watch-${Math.random().toString(36).slice(2)}`)
    await mkdir(root, { recursive: true })
    const bridge = new SyncBridge({ root, remote: server.connect() })
    try {
      await bridge.start()
      await bridge.idle()
      await new Promise((resolve) => setTimeout(resolve, 300)) // let the watcher finish its initial scan

      await writeFile(path.join(root, 'watched.txt'), 'after a normal save')

      await expect.poll(() => server.text(id), { timeout: 10_000, interval: 100 }).toBe('after a normal save')
    } finally {
      await bridge.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
