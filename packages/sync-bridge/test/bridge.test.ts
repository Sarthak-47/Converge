import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SyncBridge, type BridgeEvent } from '../src/bridge.js'
import { MemoryServer, type MemoryClient } from './memoryRemote.js'

/**
 * Gate F (design §19.2): the local mirror's safety rules, tested with two "machines" (bridges on separate
 * folders) against an in-memory workspace. Temporary folders live inside the repository's .tmp, never in the
 * system temp directory.
 */
const SCRATCH = path.resolve(import.meta.dirname, '../../../.tmp/sync-tests')

type Machine = { bridge: SyncBridge; client: MemoryClient; root: string; events: BridgeEvent[] }

let server: MemoryServer
let machines: Machine[]

async function machine(name: string): Promise<Machine> {
  const root = path.join(SCRATCH, `${name}-${Math.random().toString(36).slice(2)}`)
  await mkdir(root, { recursive: true })
  const client = server.connect()
  const events: BridgeEvent[] = []
  const bridge = new SyncBridge({ root, remote: client, watch: false, onEvent: (e) => events.push(e) })
  const m = { bridge, client, root, events }
  machines.push(m)
  return m
}

async function started(name: string) {
  const m = await machine(name)
  await m.bridge.start()
  await m.bridge.idle()
  return m
}

const read = (m: Machine, file: string) => readFile(path.join(m.root, file), 'utf8')

async function writeLocal(m: Machine, file: string, text: string) {
  await mkdir(path.dirname(path.join(m.root, file)), { recursive: true })
  await writeFile(path.join(m.root, file), text)
  await m.bridge.diskChanged(file)
  await settle()
}

/** Lets every bridge finish what the last change triggered. */
async function settle() {
  for (let round = 0; round < 3; round++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await Promise.all(machines.map((m) => m.bridge.idle()))
  }
}

beforeEach(() => {
  server = new MemoryServer()
  machines = []
})

afterEach(async () => {
  await Promise.all(machines.map((m) => m.bridge.stop()))
  await Promise.all(machines.map((m) => rm(m.root, { recursive: true, force: true })))
})

describe('mirroring', () => {
  it('writes every workspace file into the checkout on start', async () => {
    server.addFolder('src')
    server.addFile('src/main.ts', 'export {}\n')
    server.addFile('README.md', '# hello\n')

    const a = await started('a')

    expect(await read(a, 'src/main.ts')).toBe('export {}\n')
    expect(await read(a, 'README.md')).toBe('# hello\n')
  })

  it("writes a teammate's edit to disk", async () => {
    const id = server.addFile('notes.txt', 'one')
    const a = await started('a')

    server.edit(id, (t) => t.insert(3, ' two'))
    await settle()

    expect(await read(a, 'notes.txt')).toBe('one two')
  })

  it('sends a local edit as a minimal change that keeps concurrent edits elsewhere', async () => {
    const id = server.addFile('doc.txt', 'alpha\nbeta\n')
    const a = await started('a')

    server.edit(id, (t) => t.insert(t.length, 'gamma\n')) // a collaborator appends...
    await writeFile(path.join(a.root, 'doc.txt'), 'ALPHA\nbeta\n') // ...while this machine edits line one
    await a.bridge.diskChanged('doc.txt')
    await settle()

    expect(server.text(id)).toBe('ALPHA\nbeta\ngamma\n')
    expect(await read(a, 'doc.txt')).toBe('ALPHA\nbeta\ngamma\n')
  })

  it('keeps two machines identical', async () => {
    const id = server.addFile('shared.md', 'start')
    const a = await started('a')
    const b = await started('b')

    await writeLocal(a, 'shared.md', 'start, edited on A')

    expect(await read(b, 'shared.md')).toBe('start, edited on A')
    expect(server.text(id)).toBe('start, edited on A')
  })

  it('creates files that appear locally', async () => {
    const a = await started('a')
    const b = await started('b')

    await writeLocal(a, 'new/file.ts', 'const created = true\n')

    const id = server.idOf('new/file.ts')
    expect(id).toBeDefined()
    expect(server.text(id!)).toBe('const created = true\n')
    expect(await read(b, 'new/file.ts')).toBe('const created = true\n')
  })

  it('preserves CRLF line endings on disk while the live document holds LF', async () => {
    const id = server.addFile('win.txt', 'line one\nline two\n')
    const a = await started('a')
    await writeLocal(a, 'win.txt', 'line one\r\nline two\r\n')
    expect(server.text(id)).toBe('line one\nline two\n')

    server.edit(id, (t) => t.insert(t.length, 'line three\n'))
    await settle()

    expect(await read(a, 'win.txt')).toBe('line one\r\nline two\r\nline three\r\n')
  })
})

describe('safety (Gate F)', () => {
  it('does not echo its own writes back to the workspace', async () => {
    const id = server.addFile('echo.txt', 'v1')
    const a = await started('a')
    server.edit(id, (t) => t.insert(2, ' v2'))
    await settle()
    const sentBefore = a.client.updatesSent

    await a.bridge.diskChanged('echo.txt') // the watcher reporting the bridge's own write
    await settle()

    expect(a.client.updatesSent).toBe(sentBefore)
    expect(a.events.filter((e) => e.type === 'sent')).toHaveLength(0)
  })

  it('never overwrites unsynced local edits when a remote change arrives', async () => {
    const id = server.addFile('race.txt', 'base text\n')
    const a = await started('a')

    // The disk changes, but the watcher has not reported it yet when a remote edit lands.
    await writeFile(path.join(a.root, 'race.txt'), 'base text\nlocal line\n')
    server.edit(id, (t) => t.insert(0, 'remote line\n'))
    await settle()

    const merged = 'remote line\nbase text\nlocal line\n'
    expect(await read(a, 'race.txt')).toBe(merged)
    expect(server.text(id)).toBe(merged)
  })

  it('refuses paths that would escape the checkout or touch .git', async () => {
    server.addFile('../outside.txt', 'escape')
    server.addFile('.git/hooks/pre-commit', 'rm -rf /')
    server.addFile('.converge/state', 'tamper')
    server.addFile('C:/absolute.txt', 'absolute')
    server.addFile('ok.txt', 'fine')

    const a = await started('a')

    expect(await read(a, 'ok.txt')).toBe('fine')
    expect(a.events.filter((e) => e.type === 'refused').map((e) => e.path)).toEqual(
      expect.arrayContaining(['../outside.txt', '.git/hooks/pre-commit', '.converge/state', 'C:/absolute.txt']),
    )
    await expect(readFile(path.join(a.root, '..', 'outside.txt'))).rejects.toThrow()
    await expect(readFile(path.join(a.root, '.git', 'hooks', 'pre-commit'))).rejects.toThrow()
  })

  it('moves remotely deleted files to the trash instead of deleting them', async () => {
    const id = server.addFile('gone.txt', 'keep me safe')
    const a = await started('a')

    server.remove(id)
    await settle()

    await expect(readFile(path.join(a.root, 'gone.txt'))).rejects.toThrow()
    const trashed = a.events.find((e) => e.type === 'trashed')
    expect(trashed).toBeDefined()
    expect(await readFile(path.join(a.root, (trashed as { to: string }).to), 'utf8')).toBe('keep me safe')
  })

  it('keeps a differing local copy in the trash when first binding to the workspace', async () => {
    server.addFile('existing.txt', 'workspace version')
    const a = await machine('a')
    await writeFile(path.join(a.root, 'existing.txt'), 'old local version')

    await a.bridge.start()
    await settle()

    expect(await read(a, 'existing.txt')).toBe('workspace version')
    const trashed = a.events.find((e) => e.type === 'trashed') as { to: string }
    expect(await readFile(path.join(a.root, trashed.to), 'utf8')).toBe('old local version')
  })

  it('ignores .gitignore entries, node_modules and binary files', async () => {
    const a = await machine('a')
    await writeFile(path.join(a.root, '.gitignore'), 'build/\n*.log\n')
    await a.bridge.start()

    await writeLocal(a, 'build/out.js', 'compiled')
    await writeLocal(a, 'debug.log', 'noise')
    await writeLocal(a, 'node_modules/pkg/index.js', 'dependency')
    await writeFile(path.join(a.root, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    await a.bridge.diskChanged('image.png')
    await settle()

    const paths = [...server.entries.values()].map((e) => e.path)
    expect(paths).not.toContain('build/out.js')
    expect(paths).not.toContain('debug.log')
    expect(paths).not.toContain('node_modules/pkg/index.js')
    expect(paths).not.toContain('image.png')
  })

  it('merges edits made while offline when the connection returns', async () => {
    const id = server.addFile('offline.txt', 'shared start\n')
    const a = await started('a')
    const b = await started('b')

    a.client.goOffline()
    await writeLocal(a, 'offline.txt', 'shared start\nwritten offline on A\n')
    await writeLocal(b, 'offline.txt', 'written online on B\nshared start\n')
    a.client.goOnline()
    await settle()

    const expected = 'written online on B\nshared start\nwritten offline on A\n'
    expect(server.text(id)).toBe(expected)
    expect(await read(a, 'offline.txt')).toBe(expected)
    expect(await read(b, 'offline.txt')).toBe(expected)
  })

  it('merges edits made while the app was closed when it starts again', async () => {
    const id = server.addFile('notes.md', 'line one\n')
    const first = await started('first')
    await first.bridge.stop()

    // While the app is closed, this machine edits the file and a teammate edits the workspace.
    await writeFile(path.join(first.root, 'notes.md'), 'line one\nwritten while closed\n')
    server.edit(id, (t) => t.insert(0, 'teammate line\n'))

    const events: BridgeEvent[] = []
    const again = new SyncBridge({ root: first.root, remote: server.connect(), watch: false, onEvent: (e) => events.push(e) })
    machines.push({ bridge: again, client: server.connect(), root: first.root, events })
    await again.start()
    await settle()

    const merged = 'teammate line\nline one\nwritten while closed\n'
    expect(server.text(id)).toBe(merged)
    expect(await read(first, 'notes.md')).toBe(merged)
    expect(events.some((e) => e.type === 'trashed')).toBe(false)
  })

  it('follows a remote rename by moving the local file', async () => {
    const id = server.addFile('old-name.txt', 'content')
    const a = await started('a')

    server.move(id, 'renamed/new-name.txt')
    await settle()

    expect(await read(a, 'renamed/new-name.txt')).toBe('content')
    expect((await readdir(a.root)).includes('old-name.txt')).toBe(false)
  })
})
