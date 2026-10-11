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

/**
 * One file's live replica: a Yjs document kept in sync with the collaboration service. Local edits are
 * applied immediately and sent in the background; while offline they queue up and merge on reconnect.
 * Each connection attempt fetches a fresh single-use ticket (design §14.4).
 */
export class CollabDocument {
  readonly doc = new Y.Doc()
  readonly text: Y.Text = this.doc.getText(TEXT_FIELD)
  readonly provider: HocuspocusProvider
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

  destroy() {
    this.provider.destroy()
    this.doc.destroy()
  }
}
