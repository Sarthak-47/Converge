import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import ignore, { type Ignore } from 'ignore'
import * as Y from 'yjs'
import { assertNoLinks, BRIDGE_DIR, resolveInside, toWorkspacePath, UnsafePathError } from './paths.js'
import { TEXT_FIELD, type RemoteEntry, type RemoteWorkspace } from './remote.js'
import { applyTextChange, detectEol, looksBinary, MAX_SYNC_BYTES, toLf, withEol, type Eol } from './text.js'

export type BridgeEvent =
  | { type: 'written'; path: string }
  | { type: 'sent'; path: string }
  | { type: 'created'; path: string }
  | { type: 'deleted'; path: string }
  | { type: 'trashed'; path: string; to: string }
  | { type: 'skipped'; path: string; reason: string }
  | { type: 'refused'; path: string; reason: string }
  | { type: 'error'; path: string; message: string }

export type BridgeOptions = {
  /** The local checkout. */
  root: string
  remote: RemoteWorkspace
  onEvent?: (event: BridgeEvent) => void
  /** Watch the folder for changes (default true). Tests drive changes explicitly instead. */
  watch?: boolean
}

/**
 * One mirrored file. The base is what the disk is known to contain: its text, and a Yjs state whose text is
 * exactly that. Local edits are diffed against the base and applied to a fork of the base state, so Yjs can
 * merge them with remote edits made since (a true three-way merge, not a last-writer-wins overwrite).
 */
type Tracked = {
  id: string
  path: string
  absolute: string
  doc: Y.Doc
  text: Y.Text
  baseText: string | null
  baseState: Uint8Array | null
  eol: Eol
  stopObserving: () => void
}

type DiskRead = { kind: 'text'; raw: string } | { kind: 'missing' } | { kind: 'skip'; reason: string }

/** Always excluded, whatever .gitignore says (design §12.7). */
const ALWAYS_IGNORED = ['.git', BRIDGE_DIR, 'node_modules', '*.converge-tmp-*']

/**
 * Keeps a local folder in live two-way sync with a workspace (design §12.3–§12.7).
 *
 * Every file has a serial queue, so one file never has two operations in flight. A disk change equal to the
 * base is the bridge's own echo and is ignored. Before a remote change is written, any unsynced local edits
 * are merged in first, so writing can never overwrite them.
 */
export class SyncBridge {
  private readonly files = new Map<string, Tracked>()
  private readonly queues = new Map<string, Promise<void>>()
  /** Transaction origin of edits that came from this machine's disk. */
  private readonly origin = Symbol('sync-bridge')
  private ignored: Ignore = ignore().add(ALWAYS_IGNORED)
  private watcher: FSWatcher | null = null
  private stopTree: (() => void) | null = null
  private stopped = false

  constructor(private readonly options: BridgeOptions) {}

  get root() {
    return path.resolve(this.options.root)
  }

  async start(): Promise<void> {
    await mkdir(path.join(this.root, BRIDGE_DIR), { recursive: true })
    await writeFile(path.join(this.root, BRIDGE_DIR, '.gitignore'), '*\n')
    try {
      this.ignored = ignore().add(ALWAYS_IGNORED).add(await readFile(path.join(this.root, '.gitignore'), 'utf8'))
    } catch {
      // No .gitignore: the built-in exclusions still apply.
    }
    await this.enqueue('*tree', () => this.reconcile())
    this.stopTree = this.options.remote.onTreeChanged(() => void this.enqueue('*tree', () => this.reconcile()))
    if (this.options.watch !== false) this.startWatching()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.stopTree?.()
    await this.watcher?.close()
    await this.idle()
    for (const tracked of [...this.files.values()]) this.untrack(tracked)
  }

  /** Waits until every queued operation, including ones queued meanwhile, has finished. */
  async idle(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.all([...this.queues.values()])
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** Reports a change to a file on disk; the watcher calls this, and so can tests. */
  diskChanged(workspacePath: string): Promise<void> {
    return this.enqueue(workspacePath, () => this.readFromDisk(workspacePath))
  }

  isIgnored(workspacePath: string): boolean {
    try {
      return workspacePath === '' || this.ignored.ignores(workspacePath)
    } catch {
      // The ignore library throws on paths that are not plain relative paths; those are unsafe, not ignored.
      return false
    }
  }

  /** True when a workspace path could not be written inside the checkout at all. */
  private isUnsafe(workspacePath: string): boolean {
    try {
      resolveInside(this.root, workspacePath)
      return false
    } catch {
      return true
    }
  }

  private emit(event: BridgeEvent) {
    this.options.onEvent?.(event)
  }

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(task).catch((error: unknown) => {
      this.emit({ type: 'error', path: key, message: error instanceof Error ? error.message : String(error) })
    })
    this.queues.set(key, next)
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key)
    })
    return next
  }

  // ---- Remote → local --------------------------------------------------------------------------------------

  /** Aligns tracked files with the workspace tree: new files are mirrored, moves and deletes applied. */
  private async reconcile(): Promise<void> {
    if (this.stopped) return
    const entries = await this.options.remote.list()
    const byId = new Map(entries.filter((e) => e.kind === 'FILE').map((e) => [e.id, e]))

    for (const tracked of [...this.files.values()]) {
      const entry = byId.get(tracked.id)
      if (!entry) await this.enqueue(tracked.path, () => this.remoteDeleted(tracked))
      else if (entry.path !== tracked.path) await this.enqueue(tracked.path, () => this.remoteMoved(tracked, entry))
    }
    const trackedIds = new Set([...this.files.values()].map((t) => t.id))
    for (const entry of entries) {
      if (entry.kind === 'FOLDER') await this.ensureFolder(entry.path)
      // Unsafe paths go to track() so they are refused and reported, not silently skipped as ignored.
      else if (!trackedIds.has(entry.id) && (this.isUnsafe(entry.path) || !this.isIgnored(entry.path))) {
        await this.enqueue(entry.path, async () => {
          await this.track(entry, false)
        })
      }
    }
  }

  private async ensureFolder(workspacePath: string) {
    try {
      const absolute = resolveInside(this.root, workspacePath)
      await assertNoLinks(this.root, absolute)
      await mkdir(absolute, { recursive: true })
    } catch (error) {
      this.refuse(workspacePath, error)
    }
  }

  /** Starts mirroring one file. `preferLocal` is true when the file was just created from this disk. */
  private async track(entry: RemoteEntry, preferLocal: boolean): Promise<Tracked | null> {
    if (this.files.has(entry.path)) return this.files.get(entry.path)!
    let absolute: string
    try {
      absolute = resolveInside(this.root, entry.path)
      await assertNoLinks(this.root, absolute)
    } catch (error) {
      this.refuse(entry.path, error)
      return null
    }
    const doc = await this.options.remote.open(entry.id)
    const text = doc.getText(TEXT_FIELD)
    const tracked: Tracked = {
      id: entry.id, path: entry.path, absolute, doc, text,
      baseText: null, baseState: null, eol: '\n', stopObserving: () => undefined,
    }
    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin !== this.origin) void this.enqueue(tracked.path, () => this.writeFromRemote(tracked))
    }
    text.observe(observer)
    tracked.stopObserving = () => text.unobserve(observer)
    this.files.set(entry.path, tracked)

    const disk = await this.readDisk(absolute)
    if (disk.kind === 'skip') {
      this.emit({ type: 'skipped', path: entry.path, reason: disk.reason })
    } else if (disk.kind === 'text' && preferLocal) {
      this.setBase(tracked, text.toString(), Y.encodeStateAsUpdate(doc))
      this.mergeLocal(tracked, disk.raw)
    } else if (disk.kind === 'text' && toLf(disk.raw) === text.toString()) {
      tracked.eol = detectEol(disk.raw)
      this.setBase(tracked, text.toString(), Y.encodeStateAsUpdate(doc))
    } else {
      // First bind: the live document wins (design §12.9). A differing local copy is kept in the trash.
      if (disk.kind === 'text') await this.moveToTrash(tracked)
      await this.writeToDisk(tracked)
    }
    return tracked
  }

  private async writeFromRemote(tracked: Tracked): Promise<void> {
    if (this.files.get(tracked.path) !== tracked) return
    const disk = await this.readDisk(tracked.absolute)
    if (disk.kind === 'skip') return this.emit({ type: 'skipped', path: tracked.path, reason: disk.reason })
    if (disk.kind === 'text') {
      // Unsynced local edits: merge them in first, so writing the merged text cannot overwrite them.
      if (toLf(disk.raw) !== tracked.baseText) this.mergeLocal(tracked, disk.raw)
      if (toLf(disk.raw) === tracked.text.toString()) {
        this.setBase(tracked, tracked.text.toString(), Y.encodeStateAsUpdate(tracked.doc))
        return
      }
    }
    await this.writeToDisk(tracked)
  }

  private async writeToDisk(tracked: Tracked): Promise<void> {
    const live = tracked.text.toString()
    await mkdir(path.dirname(tracked.absolute), { recursive: true })
    await assertNoLinks(this.root, tracked.absolute)
    // Set the base before writing, so the watcher sees the resulting change as our own echo.
    this.setBase(tracked, live, Y.encodeStateAsUpdate(tracked.doc))
    const temporary = `${tracked.absolute}.converge-tmp-${randomBytes(4).toString('hex')}`
    await writeFile(temporary, withEol(live, tracked.eol), 'utf8')
    await renameWithRetry(temporary, tracked.absolute)
    this.emit({ type: 'written', path: tracked.path })
  }

  private async remoteMoved(tracked: Tracked, entry: RemoteEntry): Promise<void> {
    let target: string
    try {
      target = resolveInside(this.root, entry.path)
      await assertNoLinks(this.root, target)
    } catch (error) {
      this.refuse(entry.path, error)
      return
    }
    await mkdir(path.dirname(target), { recursive: true })
    try {
      await rename(tracked.absolute, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.files.delete(tracked.path)
    tracked.path = entry.path
    tracked.absolute = target
    this.files.set(entry.path, tracked)
    await this.writeFromRemote(tracked)
  }

  /** A remote delete never destroys local work: the file is moved to the bridge's trash (design §12.7). */
  private async remoteDeleted(tracked: Tracked): Promise<void> {
    this.untrack(tracked)
    await this.moveToTrash(tracked)
  }

  private async moveToTrash(tracked: Tracked) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const to = path.join(this.root, BRIDGE_DIR, 'trash', stamp, ...tracked.path.split('/'))
    try {
      await mkdir(path.dirname(to), { recursive: true })
      await rename(tracked.absolute, to)
      this.emit({ type: 'trashed', path: tracked.path, to: toWorkspacePath(this.root, to) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  // ---- Local → remote --------------------------------------------------------------------------------------

  private async readFromDisk(workspacePath: string): Promise<void> {
    if (this.stopped || this.isIgnored(workspacePath)) return
    let absolute: string
    try {
      absolute = resolveInside(this.root, workspacePath)
    } catch (error) {
      this.refuse(workspacePath, error)
      return
    }
    const tracked = this.files.get(workspacePath)
    const disk = await this.readDisk(absolute)
    if (disk.kind === 'skip') return this.emit({ type: 'skipped', path: workspacePath, reason: disk.reason })
    if (disk.kind === 'missing') {
      if (!tracked) return
      this.untrack(tracked)
      await this.options.remote.deleteFile(tracked.id)
      this.emit({ type: 'deleted', path: workspacePath })
      return
    }
    if (tracked) {
      // Equal text means our own echo, or only the line endings changed: keep the new style for later writes.
      if (toLf(disk.raw) === tracked.baseText) tracked.eol = detectEol(disk.raw)
      else this.mergeLocal(tracked, disk.raw)
      return
    }
    const entry = await this.options.remote.createFile(workspacePath)
    this.emit({ type: 'created', path: workspacePath })
    await this.track(entry, true)
  }

  /**
   * Three-way merge of a local edit: diff the disk text against the base, apply that diff to a fork of the
   * base state, and send only the fork's new operations. Yjs merges them with any remote edits made since the
   * base, exactly as it merges two people typing.
   */
  private mergeLocal(tracked: Tracked, raw: string) {
    const local = toLf(raw)
    tracked.eol = detectEol(raw)
    if (tracked.baseState === null || tracked.baseText === null) {
      tracked.doc.transact(() => applyTextChange(tracked.text, local), this.origin)
      this.setBase(tracked, local, Y.encodeStateAsUpdate(tracked.doc))
    } else {
      const fork = new Y.Doc()
      Y.applyUpdate(fork, tracked.baseState)
      if (!applyTextChange(fork.getText(TEXT_FIELD), local)) return
      Y.applyUpdate(tracked.doc, Y.encodeStateAsUpdate(fork, Y.encodeStateVector(tracked.doc)), this.origin)
      this.setBase(tracked, local, Y.encodeStateAsUpdate(fork))
      fork.destroy()
    }
    this.emit({ type: 'sent', path: tracked.path })
  }

  private setBase(tracked: Tracked, text: string, state: Uint8Array) {
    tracked.baseText = text
    tracked.baseState = state
  }

  // ---- Helpers ---------------------------------------------------------------------------------------------

  private async readDisk(absolute: string): Promise<DiskRead> {
    let bytes: Buffer
    try {
      bytes = await readFile(absolute)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { kind: 'missing' }
      if (code === 'EISDIR') return { kind: 'skip', reason: 'is a folder' }
      throw error
    }
    if (bytes.length > MAX_SYNC_BYTES) return { kind: 'skip', reason: 'larger than 1 MB' }
    if (looksBinary(bytes)) return { kind: 'skip', reason: 'binary file' }
    return { kind: 'text', raw: bytes.toString('utf8') }
  }

  private untrack(tracked: Tracked) {
    tracked.stopObserving()
    this.options.remote.close(tracked.id)
    if (this.files.get(tracked.path) === tracked) this.files.delete(tracked.path)
  }

  private refuse(workspacePath: string, error: unknown) {
    if (error instanceof UnsafePathError) this.emit({ type: 'refused', path: workspacePath, reason: error.message })
    else throw error
  }

  private startWatching() {
    this.watcher = watch(this.root, {
      ignoreInitial: true,
      ignored: (absolute) => {
        const relative = toWorkspacePath(this.root, absolute)
        return relative !== '' && this.isIgnored(relative)
      },
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    const onFile = (absolute: string) => void this.diskChanged(toWorkspacePath(this.root, absolute))
    this.watcher.on('add', onFile).on('change', onFile).on('unlink', onFile)
  }
}

/** Windows briefly locks files that editors or virus scanners have open; retry instead of failing. */
async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= attempts || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) {
        await rm(from, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt))
    }
  }
}
