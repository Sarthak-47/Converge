import type * as Y from 'yjs'

/** Name of the shared type holding a file's text; the editor and collaboration service use the same name. */
export const TEXT_FIELD = 'content'

export type FileEntry = { id: string; path: string; kind: 'FILE' | 'FOLDER' }
export type SearchHit = { path: string; line: number; text: string }

/**
 * The workspace as one agent turn sees it. Documents are opened as the turn's own Yjs client, with garbage
 * collection off so the content the agent deletes stays available for "Revert this turn" (design §13.2).
 */
export interface TurnWorkspace {
  list(): Promise<FileEntry[]>
  /**
   * Opens a file's live document. `initialState`, when given, is applied before the first sync: a revert
   * needs the deleted content recorded at the end of the turn, which the server itself no longer keeps.
   */
  open(fileId: string, initialState?: Uint8Array): Promise<Y.Doc>
  createFile(path: string): Promise<FileEntry>
  /** Literal search over the workspace's stored text; may trail live typing by a few seconds. */
  search(query: string): Promise<SearchHit[]>
  /** Shows the agent's cursor in a file (`null` hides it). */
  setCursor(fileId: string, index: number | null): void
  /** Waits until every local change has reached the server. */
  flush(): Promise<void>
  close(): Promise<void>
}
