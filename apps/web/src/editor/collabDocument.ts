import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { api } from '../api.ts'

/** What the status bar shows for a live document. */
export type SyncState = 'connecting' | 'syncing' | 'saving' | 'saved' | 'offline' | 'denied' | 'deleted'

/** Name of the shared type holding a file's text; the collaboration service uses the same name. */
const TEXT_FIELD = 'content'

function collabUrl() {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/collab`
}

// The sticker palette (index.css --sticker-1..6): one die-cut colour per person, all clear of lemon, which belongs to
// primary actions and Live. Kept as hsl() strings, the only form awareness validation accepts from other clients.
const THREADS = ['hsl(9 100% 59%)', 'hsl(230 100% 58%)', 'hsl(153 79% 43%)', 'hsl(333 100% 69%)', 'hsl(258 72% 52%)', 'hsl(195 100% 42%)']

/** Ink that stays readable on a sticker of `color` (an hsl() string): near-black or white, whichever contrasts more. */
export function inkFor(color: string): string {
  const match = /^hsl\((\d{1,3}) (\d{1,3})% (\d{1,3})%\)$/.exec(color)
  if (!match) return '#16171a'
  const [h, s, l] = [Number(match[1]) % 360, Number(match[2]) / 100, Number(match[3]) / 100]
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number) => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const lum = 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4)
  const onWhite = 1.05 / (lum + 0.05)
  const onInk = (lum + 0.05) / 0.0587
  return onInk >= onWhite ? '#16171a' : '#ffffff'
}

// Inside a workspace, colours are dealt in roster order (join time, then name: the same on every client), so up to
// six members never share one. Anyone not on the roster, and every page outside a workspace, falls back to a hash.
let dealt = new Map<string, string>()

/** Deals sticker colours to a workspace's members in roster order; an empty list clears the assignment. */
export function assignColors(memberIds: string[]) {
  dealt = new Map(memberIds.map((id, i) => [id, THREADS[i % THREADS.length]]))
}

/** A stable, readable colour per user, so the same person looks the same in every tab. */
export function colorFor(userId: string) {
  const assigned = dealt.get(userId)
  if (assigned) return assigned
  let hash = 0
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return THREADS[Math.abs(hash) % THREADS.length]
}

/** Someone else editing the same file, as announced through Yjs awareness. */
export type Peer = { clientId: number; name: string; color: string }

const SAFE_COLOR = /^hsl\(\d{1,3} \d{1,3}% \d{1,3}%\)$/

/** Awareness data comes from other clients, so it is validated before it reaches the UI or any CSS. */
function toPeer(clientId: number, state: Record<string, unknown>): Peer | null {
  const user = state.user as { name?: unknown; color?: unknown } | undefined
  if (!user || typeof user.name !== 'string') return null
  const color = typeof user.color === 'string' && SAFE_COLOR.test(user.color) ? user.color : 'hsl(220 8% 52%)'
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
  private deleted = false
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
      onClose: ({ event }) => {
        // 4403: the server closed the connection because workspace access was removed (FR-18).
        if (event.code === 4403) {
          this.denied = true
          this.emit()
        }
        // 4404: the file was deleted while open (design §8.10).
        if (event.code === 4404) {
          this.deleted = true
          this.emit()
        }
      },
    })
    this.provider.setAwarenessField('user', { name: user.displayName, color: colorFor(user.id) })
    this.provider.awareness?.on('change', this.onAwareness)
  }

  get state(): SyncState {
    if (this.deleted) return 'deleted'
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
