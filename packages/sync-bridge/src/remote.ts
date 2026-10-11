import type * as Y from 'yjs'

/** A file or folder as the workspace knows it. */
export type RemoteEntry = { id: string; path: string; kind: 'FILE' | 'FOLDER' }

/**
 * Everything the bridge needs from a workspace. The desktop app implements it with the HTTP API and the
 * collaboration service; tests implement it with in-memory Yjs documents, so the mirror logic can be checked
 * deterministically without a network.
 */
export interface RemoteWorkspace {
  /** Every live file and folder. */
  list(): Promise<RemoteEntry[]>
  /** A replica of the file's live document, resolved once it has synced with the server. */
  open(fileId: string): Promise<Y.Doc>
  close(fileId: string): void
  createFile(path: string): Promise<RemoteEntry>
  deleteFile(fileId: string): Promise<void>
  /** Called whenever the file tree may have changed (created, moved or deleted entries). */
  onTreeChanged(listener: () => void): () => void
}

/** Name of the Y.Text holding a file's content; shared with the server and the web client. */
export const TEXT_FIELD = 'content'
