import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * The only bridge between the web app and the desktop main process (design §12.12): a handful of named
 * operations, no general-purpose IPC and no Node APIs in the page.
 */
contextBridge.exposeInMainWorld('convergeDesktop', {
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('sync:choose-folder'),
  startSync: (workspaceId: string, folder: string): Promise<{ started: boolean }> =>
    ipcRenderer.invoke('sync:start', { workspaceId, folder }),
  stopSync: (): Promise<void> => ipcRenderer.invoke('sync:stop'),
  status: (): Promise<{ workspaceId: string; folder: string } | null> => ipcRenderer.invoke('sync:status'),
  onSyncEvent: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on('sync:event', handler)
    return () => ipcRenderer.off('sync:event', handler)
  },
})
