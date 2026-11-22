import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * The only bridge between the web app and the desktop main process (design §12.12): a handful of named
 * operations, no general-purpose IPC and no Node APIs in the page.
 */
contextBridge.exposeInMainWorld('convergeDesktop', {
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('sync:choose-folder'),
  startSync: (workspaceId: string, folder: string): Promise<{ started: boolean; paused?: string | null }> =>
    ipcRenderer.invoke('sync:start', { workspaceId, folder }),
  stopSync: (): Promise<void> => ipcRenderer.invoke('sync:stop'),
  status: (): Promise<{ workspaceId: string; folder: string; paused?: string | null } | null> => ipcRenderer.invoke('sync:status'),
  commitAndPush: (message: string): Promise<{ committed: boolean; pushed: boolean; sha?: string; files: number; detail: string }> =>
    ipcRenderer.invoke('git:commit-push', { message }),
  onSyncEvent: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on('sync:event', handler)
    return () => ipcRenderer.off('sync:event', handler)
  },
})

// The first-run "connect to a server" screen is a local page; only it gets this, and the main process also
// refuses these calls from anywhere else.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('convergeConnect', {
    current: (): Promise<string | null> => ipcRenderer.invoke('server:current'),
    connect: (address: string): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('server:connect', address),
  })
}
