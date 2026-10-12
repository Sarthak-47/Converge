import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BRIDGE_DIR } from './paths.js'
import type { Eol } from './text.js'

/** What the bridge must remember about a file to merge edits made while it was not running. */
export type SavedBase = { path: string; baseText: string; baseState: Uint8Array; eol: Eol }

const FILE_ID = /^[0-9a-zA-Z-]{1,64}$/

/**
 * Persists each file's base inside the checkout (`.converge/state/<fileId>.json`), so that after the app
 * restarts, edits made on disk while it was closed are merged three-way instead of being set aside (design
 * §12.6). Writes are atomic and ordered per file. Plain files rather than SQLite: no native module to
 * download, and one small file per tracked document is all this needs.
 */
export class StateStore {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  private file(fileId: string) {
    return path.join(this.root, BRIDGE_DIR, 'state', `${fileId}.json`)
  }

  async load(fileId: string): Promise<SavedBase | null> {
    if (!FILE_ID.test(fileId)) return null
    await this.pending.get(fileId)
    try {
      const raw = JSON.parse(await readFile(this.file(fileId), 'utf8')) as {
        path?: unknown; baseText?: unknown; baseState?: unknown; eol?: unknown
      }
      if (typeof raw.path !== 'string' || typeof raw.baseText !== 'string' || typeof raw.baseState !== 'string') return null
      return {
        path: raw.path,
        baseText: raw.baseText,
        baseState: new Uint8Array(Buffer.from(raw.baseState, 'base64')),
        eol: raw.eol === '\r\n' ? '\r\n' : '\n',
      }
    } catch {
      return null // missing or unreadable state just means "no known base"
    }
  }

  save(fileId: string, base: SavedBase): void {
    if (!FILE_ID.test(fileId)) return
    this.chain(fileId, async () => {
      const target = this.file(fileId)
      await mkdir(path.dirname(target), { recursive: true })
      const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`
      const body = { path: base.path, baseText: base.baseText, baseState: Buffer.from(base.baseState).toString('base64'), eol: base.eol }
      await writeFile(temporary, JSON.stringify(body))
      await rename(temporary, target)
    })
  }

  remove(fileId: string): void {
    if (!FILE_ID.test(fileId)) return
    this.chain(fileId, () => rm(this.file(fileId), { force: true }))
  }

  /** Waits for every pending write. */
  async flush(): Promise<void> {
    await Promise.all(this.pending.values())
  }

  private chain(fileId: string, task: () => Promise<void>) {
    const next = (this.pending.get(fileId) ?? Promise.resolve()).then(task).catch(() => undefined)
    this.pending.set(fileId, next)
    void next.finally(() => {
      if (this.pending.get(fileId) === next) this.pending.delete(fileId)
    })
  }
}
