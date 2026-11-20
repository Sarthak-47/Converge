/** What the desktop app's preload exposes (apps/desktop/src/preload.cts). Absent in a plain browser. */
export type SyncEvent =
  | { type: 'written' | 'sent' | 'created' | 'deleted'; path: string }
  | { type: 'trashed'; path: string; to: string }
  | { type: 'skipped' | 'refused'; path: string; reason: string }
  | { type: 'error'; path: string; message: string }

export type DesktopApi = {
  chooseFolder(): Promise<string | null>
  startSync(workspaceId: string, folder: string): Promise<{ started: boolean }>
  stopSync(): Promise<void>
  status(): Promise<{ workspaceId: string; folder: string } | null>
  /** Commits the local checkout and pushes it with the member's own Git credentials (design §12.8). */
  commitAndPush(message: string): Promise<{ committed: boolean; pushed: boolean; sha?: string; files: number; detail: string }>
  onSyncEvent(listener: (event: SyncEvent) => void): () => void
}

export const desktop: DesktopApi | undefined = (window as unknown as { convergeDesktop?: DesktopApi }).convergeDesktop
