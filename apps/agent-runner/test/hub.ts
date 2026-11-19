import * as Y from 'yjs'

/**
 * A minimal stand-in for the collaboration service: one server document (with garbage collection on, like
 * the real one) and any number of client documents whose updates are delivered asynchronously, so edits
 * from different clients interleave the way they do over a network.
 */
export class Hub {
  readonly server = new Y.Doc()
  private readonly clients = new Set<Y.Doc>()
  private pending: Array<() => void> = []

  connect(doc: Y.Doc): () => void {
    // Sync step: both sides send what the other lacks.
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(this.server, Y.encodeStateVector(doc)), this)
    Y.applyUpdate(this.server, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(this.server)), doc)
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return
      this.pending.push(() => this.broadcast(update, doc))
      queueMicrotask(() => this.drainOne())
    }
    doc.on('update', onUpdate)
    this.clients.add(doc)
    return () => {
      doc.off('update', onUpdate)
      this.clients.delete(doc)
    }
  }

  private drainOne() {
    this.pending.shift()?.()
  }

  private broadcast(update: Uint8Array, from: Y.Doc) {
    Y.applyUpdate(this.server, update, from)
    for (const client of this.clients) {
      if (client !== from) Y.applyUpdate(client, update, this)
    }
  }

  /** Delivers everything in flight. */
  async settle() {
    while (this.pending.length > 0) {
      this.drainOne()
      await Promise.resolve()
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  text() {
    return this.server.getText('content').toString()
  }
}
