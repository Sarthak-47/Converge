import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { api } from '../api.ts'

/** What the status bar shows for a live document. */
export type SyncState = 'connecting' | 'syncing' | 'saving' | 'saved' | 'offline' | 'denied'

/** Name of the shared type holding a file's text; the collaboration service uses the same name. */
const TEXT_FIELD = 'content'

function collabUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/collab`
}

/** A stable, readable colour per user, so the same person looks the same in every tab. */
export function colorFor(userId: string) {
  let hash = 0
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return `hsl(${Math.abs(hash) % 360} 70% 45%)`
}

/** Someone else editing the same file, as announced through Yjs awareness. */
export type Peer = { clientId: number; name: string; color: string }

const SAFE_COLOR = /^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/

/** Awareness data comes from other clients, so it is validated before it reaches the UI or any CSS. */
function toPeer(clientId: number, state: Record<string, unknown>): Peer | null {
  const user = state.user as { name?: unknown; color?: unknown } | undefined
  if (!user || typeof user.name !== 'string') return null
  const color = typeof user.color === 'string' && SAFE_COLOR.test(user.color) ? user.color : 'hsl(30 90% 50%)'
  return { clientId, name: user.name.slice(0, 80), color }
}

/**
 * One file's live replica: a Yjs document kept in sync with the collaboration service. Local edits are
 * applied immediately and sent in the background; while offline they queue up and merge on reconnect.
 * Each connection attempt fetches a fresh single-use ticket (design §14.4).
 */
export class CollabDocument {
  readonly doc = new Y.Doc()
  readonly text: Y.Text = this.doc.getText(TEXT_FIELD)
  readonly provider: HocuspocusProvider
  /**
   * Undo history of this person's own edits only (design §8.8). The editor binding registers itself as a
   * tracked origin, so remote edits and external changes are never undone by Ctrl+Z.
   */
  readonly undoManager = new Y.UndoManager(this.text, { trackedOrigins: new Set() })
  private status: WebSocketStatus = WebSocketStatus.Connecting
  private denied = false
  private onChange: (state: SyncState) => void

  constructor(fileId: string, user: { id: string; displayName: string }, onChange: (state: SyncState) => void) {
    this.onChange = onChange
    this.provider = new HocuspocusProvider({
      url: collabUrl(),
      name: fileId,
      document: this.doc,
      token: async () => (await api.ticket(fileId)).ticket,
      onStatus: ({ status }) => {
        this.status = status
        this.emit()
      },
      onSynced: () => this.emit(),
      onUnsyncedChanges: () => this.emit(),
      onAuthenticationFailed: () => {
        this.denied = true
        this.emit()
      },
    })
    this.provider.setAwarenessField('user', { name: user.displayName, color: colorFor(user.id) })
    this.provider.awareness?.on('change', this.onAwareness)
  }

  get state(): SyncState {
    if (this.denied) return 'denied'
    if (this.status === WebSocketStatus.Disconnected) return 'offline'
    if (this.status === WebSocketStatus.Connecting) return 'connecting'
    if (!this.provider.isSynced) return 'syncing'
    return this.provider.hasUnsyncedChanges ? 'saving' : 'saved'
  }

  get hasUnsyncedChanges() {
    return this.provider.hasUnsyncedChanges
  }

  private emit() {
    this.onChange(this.state)
  }

  private peerList: Peer[] = []
  private peerListeners = new Set<() => void>()
  private readonly onAwareness = () => {
    this.peerList = this.readPeers()
    this.peerListeners.forEach((listener) => listener())
  }

  /** Everyone else currently in this file. Stable until awareness changes, as useSyncExternalStore needs. */
  peers(): Peer[] {
    return this.peerList
  }

  /** Subscribes to peer changes; returns the unsubscribe function. */
  readonly subscribePeers = (listener: () => void): (() => void) => {
    this.peerListeners.add(listener)
    return () => this.peerListeners.delete(listener)
  }

  private readPeers(): Peer[] {
    const awareness = this.provider.awareness
    if (!awareness) return []
    const peers: Peer[] = []
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === awareness.clientID) return
      const peer = toPeer(clientId, state)
      if (peer) peers.push(peer)
    })
    return peers
  }

  destroy() {
    this.provider.awareness?.off('change', this.onAwareness)
    this.peerListeners.clear()
    this.undoManager.destroy()
    this.provider.destroy()
    this.doc.destroy()
  }
}
