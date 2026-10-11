import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { TEXT_FIELD, type RemoteEntry, type RemoteWorkspace } from '../src/remote.js'

/**
 * A stand-in for the API plus the collaboration service: one authoritative Yjs document per file, and a
 * file tree. Each connected client gets its own replicas, relayed through the "server" like a network.
 */
export class MemoryServer {
  readonly docs = new Map<string, Y.Doc>()
  readonly entries = new Map<string, RemoteEntry>()
  private readonly treeListeners = new Set<() => void>()

  addFile(path: string, text = ''): string {
    const id = randomUUID()
    const doc = new Y.Doc()
    if (text) doc.getText(TEXT_FIELD).insert(0, text)
    this.docs.set(id, doc)
    this.entries.set(id, { id, path, kind: 'FILE' })
    this.treeChanged()
    return id
  }

  addFolder(path: string): string {
    const id = randomUUID()
    this.entries.set(id, { id, path, kind: 'FOLDER' })
    this.treeChanged()
    return id
  }

  move(id: string, path: string) {
    const entry = this.entries.get(id)!
    this.entries.set(id, { ...entry, path })
    this.treeChanged()
  }

  remove(id: string) {
    this.entries.delete(id)
    this.treeChanged()
  }

  text(id: string) {
    return this.docs.get(id)!.getText(TEXT_FIELD).toString()
  }

  /** Edits a file as another collaborator would, directly on the authoritative document. */
  edit(id: string, change: (text: Y.Text) => void) {
    const doc = this.docs.get(id)!
    doc.transact(() => change(doc.getText(TEXT_FIELD)), 'collaborator')
  }

  idOf(path: string) {
    return [...this.entries.values()].find((e) => e.path === path)?.id
  }

  onTreeChanged(listener: () => void) {
    this.treeListeners.add(listener)
    return () => this.treeListeners.delete(listener)
  }

  connect(): MemoryClient {
    return new MemoryClient(this)
  }

  private treeChanged() {
    queueMicrotask(() => this.treeListeners.forEach((l) => l()))
  }
}

/** One bridge's connection. `offline` queues updates in both directions, as a dropped socket would. */
export class MemoryClient implements RemoteWorkspace {
  offline = false
  updatesSent = 0
  private readonly replicas = new Map<string, { doc: Y.Doc; detach: () => void }>()
  private readonly outbox: Array<() => void> = []

  constructor(private readonly server: MemoryServer) {}

  async list() {
    return [...this.server.entries.values()]
  }

  async open(fileId: string): Promise<Y.Doc> {
    const existing = this.replicas.get(fileId)
    if (existing) return existing.doc
    const authoritative = this.server.docs.get(fileId)
    if (!authoritative) throw new Error(`No document ${fileId}`)
    const replica = new Y.Doc()
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(authoritative), 'server')
    const toServer = (update: Uint8Array, origin: unknown) => {
      if (origin === 'server') return
      this.updatesSent++
      this.deliver(() => Y.applyUpdate(authoritative, update, this))
    }
    const toClient = (update: Uint8Array, origin: unknown) => {
      if (origin !== this) this.deliver(() => Y.applyUpdate(replica, update, 'server'))
    }
    replica.on('update', toServer)
    authoritative.on('update', toClient)
    this.replicas.set(fileId, {
      doc: replica,
      detach: () => {
        replica.off('update', toServer)
        authoritative.off('update', toClient)
      },
    })
    return replica
  }

  close(fileId: string) {
    this.replicas.get(fileId)?.detach()
    this.replicas.delete(fileId)
  }

  async createFile(path: string) {
    const id = this.server.addFile(path)
    return this.server.entries.get(id)!
  }

  async deleteFile(fileId: string) {
    this.server.remove(fileId)
  }

  onTreeChanged(listener: () => void) {
    return this.server.onTreeChanged(listener)
  }

  goOffline() {
    this.offline = true
  }

  /** Reconnects and delivers everything queued meanwhile; Yjs merges it like a resync. */
  goOnline() {
    this.offline = false
    this.outbox.splice(0).forEach((send) => send())
  }

  private deliver(send: () => void) {
    if (this.offline) this.outbox.push(send)
    else send()
  }
}
