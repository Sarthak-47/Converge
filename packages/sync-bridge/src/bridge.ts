import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import ignore, { type Ignore } from 'ignore'
import * as Y from 'yjs'
import { assertNoLinks, BRIDGE_DIR, resolveInside, toWorkspacePath, UnsafePathError } from './paths.js'
import { TEXT_FIELD, type RemoteEntry, type RemoteWorkspace } from './remote.js'
import { StateStore } from './stateStore.js'
import { applyTextChange, detectEol, looksBinary, MAX_SYNC_BYTES, toLf, withEol, type Eol } from './text.js'

/** How long a differing file must hold still before its text is taken as a local edit (see readSettled). */
const SETTLE_MS = 30

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
  /**
   * A file with no local or remote edits for this long goes cold: its live replica is closed and only its base
   * is kept, so a large checkout does not hold one open document per file (design §12.3). Default 5 minutes;
   * 0 keeps every file hot.
   */
  coolAfterMs?: number
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
  /** The live replica while the file is hot; null while it is cold (design §12.3). */
  doc: Y.Doc | null
  text: Y.Text | null
  baseText: string | null
  baseState: Uint8Array | null
  eol: Eol
  stopObserving: () => void
  coolTimer: ReturnType<typeof setTimeout> | null
}

/** A tracked file whose replica is open. */
type Hot = Tracked & { doc: Y.Doc; text: Y.Text }

const isHot = (tracked: Tracked): tracked is Hot => tracked.doc !== null

const DEFAULT_COOL_AFTER_MS = 5 * 60_000

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
  private stopContent: (() => void) | null = null
  private stopped = false
  private readonly state: StateStore

  constructor(private readonly options: BridgeOptions) {
    this.state = new StateStore(path.resolve(options.root))
  }

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
    // A cold file changed on the server: open its replica again, which writes the change (merging local edits).
    this.stopContent = this.options.remote.onContentChanged((fileId) => {
      const tracked = [...this.files.values()].find((t) => t.id === fileId)
      if (tracked && !isHot(tracked)) void this.enqueue(tracked.path, () => this.warm(tracked))
    })
    if (this.options.watch !== false) this.startWatching()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.stopTree?.()
    this.stopContent?.()
    await this.watcher?.close()
    await this.idle()
    // Stopping keeps the saved bases: they are what lets the next start merge offline edits.
    for (const tracked of [...this.files.values()]) this.untrack(tracked, false)
    await this.state.flush()
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
    const tracked: Tracked = {
      id: entry.id, path: entry.path, absolute, doc: null, text: null,
      baseText: null, baseState: null, eol: '\n', stopObserving: () => undefined, coolTimer: null,
    }
    const hot = this.attach(tracked, doc)
    const text = hot.text
    this.files.set(entry.path, tracked)

    const disk = await this.readDisk(absolute)
    const saved = disk.kind === 'text' && !preferLocal ? await this.state.load(entry.id) : null
    if (disk.kind === 'skip') {
      this.emit({ type: 'skipped', path: entry.path, reason: disk.reason })
    } else if (disk.kind === 'text' && preferLocal) {
      this.setBase(tracked, text.toString(), Y.encodeStateAsUpdate(doc))
      this.mergeLocal(hot, disk.raw)
    } else if (disk.kind === 'text' && toLf(disk.raw) === text.toString()) {
      tracked.eol = detectEol(disk.raw)
      this.setBase(tracked, text.toString(), Y.encodeStateAsUpdate(doc))
    } else if (disk.kind === 'text' && saved) {
      // Known base from the last run: merge edits made on disk while the app was closed (design §12.6).
      tracked.eol = saved.eol
      this.setBase(tracked, saved.baseText, saved.baseState)
      if (toLf(disk.raw) !== saved.baseText) this.mergeLocal(hot, disk.raw)
      if (toLf(disk.raw) === text.toString()) this.setBase(tracked, text.toString(), Y.encodeStateAsUpdate(doc))
      else await this.writeToDisk(hot)
    } else {
      // First bind: the live document wins (design §12.9). A differing local copy is kept in the trash.
      if (disk.kind === 'text') await this.moveToTrash(tracked)
      await this.writeToDisk(hot)
    }
    this.touch(tracked)
    return tracked
  }

  /** Opens a replica for a tracked file and starts writing remote edits from it. */
  private attach(tracked: Tracked, doc: Y.Doc): Hot {
    const text = doc.getText(TEXT_FIELD)
    tracked.doc = doc
    tracked.text = text
    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.origin === this.origin) return
      this.touch(tracked)
      void this.enqueue(tracked.path, () => this.writeFromRemote(tracked))
    }
    text.observe(observer)
    tracked.stopObserving = () => text.unobserve(observer)
    return tracked as Hot
  }

  /**
   * Makes a cold file hot again and catches up both ways from its base: local edits made while it was cold
   * are merged in, remote edits are written, exactly as when the app starts with a saved base (design §12.6).
   */
  private async warm(tracked: Tracked): Promise<void> {
    if (this.stopped || this.files.get(tracked.path) !== tracked) return
    if (isHot(tracked)) return this.touch(tracked)
    const doc = await this.options.remote.open(tracked.id)
    if (this.stopped || this.files.get(tracked.path) !== tracked) {
      this.options.remote.close(tracked.id)
      return
    }
    const hot = this.attach(tracked, doc)
    const disk = await this.readSettled(hot.absolute, hot.baseText)
    if (disk.kind === 'skip') return this.emit({ type: 'skipped', path: hot.path, reason: disk.reason })
    if (disk.kind === 'text' && toLf(disk.raw) !== hot.baseText) this.mergeLocal(hot, disk.raw)
    if (disk.kind === 'text' && toLf(disk.raw) === hot.text.toString()) this.setBase(hot, hot.text.toString(), Y.encodeStateAsUpdate(hot.doc))
    else await this.writeToDisk(hot)
    this.touch(tracked)
  }

  /** Closes a quiet file's replica; its base stays, so warming it later merges anything that changed meanwhile. */
  private cool(tracked: Tracked) {
    if (!isHot(tracked)) return
    tracked.stopObserving()
    tracked.stopObserving = () => undefined
    this.options.remote.close(tracked.id)
    const cold: Tracked = tracked
    cold.doc = null
    cold.text = null
  }

  /** Notes activity on a file and restarts its countdown to going cold. */
  private touch(tracked: Tracked) {
    if (tracked.coolTimer) clearTimeout(tracked.coolTimer)
    tracked.coolTimer = null
    const after = this.options.coolAfterMs ?? DEFAULT_COOL_AFTER_MS
    if (after <= 0 || this.stopped) return
    tracked.coolTimer = setTimeout(() => {
      tracked.coolTimer = null
      void this.enqueue(tracked.path, async () => {
        if (this.files.get(tracked.path) === tracked) this.cool(tracked)
      })
    }, after)
    tracked.coolTimer.unref?.()
  }

  /** Whether any file currently holds an open replica; for tests and diagnostics. */
  hotCount(): number {
    return [...this.files.values()].filter(isHot).length
  }

  private async writeFromRemote(tracked: Tracked): Promise<void> {
    if (this.files.get(tracked.path) !== tracked || !isHot(tracked)) return
    const disk = await this.readSettled(tracked.absolute, tracked.baseText)
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

  private async writeToDisk(tracked: Hot): Promise<void> {
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
    // A cold file's content did not change with the move; a hot one may have, so catch up.
    if (isHot(tracked)) await this.writeFromRemote(tracked)
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
    const disk = tracked ? await this.readSettled(absolute, tracked.baseText) : await this.readDisk(absolute)
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
      // A local edit to a cold file warms it, and warming merges the edit.
      else if (!isHot(tracked)) await this.warm(tracked)
      else {
        this.mergeLocal(tracked, disk.raw)
        this.touch(tracked)
      }
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
  private mergeLocal(tracked: Hot, raw: string) {
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
    this.state.save(tracked.id, { path: tracked.path, baseText: text, baseState: state, eol: tracked.eol })
  }

  // ---- Helpers ---------------------------------------------------------------------------------------------

  /**
   * Reads a file whose text differs from its base until two reads, a moment apart, agree. Editors save by
   * truncating and rewriting (or by deleting and recreating), so a read can land halfway through a save and
   * see an empty or missing file; merged as it is, that would delete everything. Only text that holds still
   * is taken as the edit.
   */
  private async readSettled(absolute: string, base: string | null): Promise<DiskRead> {
    let read = await this.readDisk(absolute)
    for (let attempt = 0; attempt < 8; attempt++) {
      if (read.kind === 'skip' || (read.kind === 'text' && toLf(read.raw) === base)) return read
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      const again = await this.readDisk(absolute)
      const same = again.kind === read.kind && (again.kind !== 'text' || (read.kind === 'text' && again.raw === read.raw))
      if (same) return again
      read = again
    }
    return read
  }

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

  /** Stops mirroring a file; `forget` also drops its saved base (deleted files have nothing to resume). */
  private untrack(tracked: Tracked, forget = true) {
    if (forget) this.state.remove(tracked.id)
    if (tracked.coolTimer) clearTimeout(tracked.coolTimer)
    tracked.coolTimer = null
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
