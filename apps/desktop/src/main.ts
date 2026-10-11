import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron'
import { HttpRemoteWorkspace, SyncBridge, type BridgeEvent } from '@converge/sync-bridge'

/**
 * The desktop app (design §12): the same web client as the browser, plus a sync bridge in this main process
 * that keeps a local checkout in live two-way sync with the open workspace.
 */
const SERVER = new URL(process.env.CONVERGE_URL ?? 'http://localhost:8000')
const here = path.dirname(fileURLToPath(import.meta.url))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Running = { workspaceId: string; folder: string; bridge: SyncBridge; remote: HttpRemoteWorkspace }

let window: BrowserWindow | null = null
let running: Running | null = null

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Converge',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      // The renderer is the ordinary web app: no Node, isolated from the preload, sandboxed (design §12.12).
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  // Only the Converge origin loads in the app window; anything else opens in the system browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== SERVER.origin) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  window.on('closed', () => {
    window = null
  })
  void window.loadURL(SERVER.href)
}

/** Every IPC call must come from the Converge page itself, never from other content. */
function fromApp(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url
  if (!url || new URL(url).origin !== SERVER.origin) throw new Error('IPC is only available to the Converge app')
}

function send(event: BridgeEvent) {
  window?.webContents.send('sync:event', event)
}

async function stopSync() {
  if (!running) return
  const { bridge, remote } = running
  running = null
  await bridge.stop()
  await remote.destroy()
}

ipcMain.handle('sync:choose-folder', async (event) => {
  fromApp(event)
  const result = await dialog.showOpenDialog(window!, {
    title: 'Choose a folder for this workspace',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('sync:start', async (event, request: { workspaceId?: unknown; folder?: unknown }) => {
  fromApp(event)
  if (typeof request?.workspaceId !== 'string' || !UUID.test(request.workspaceId)) throw new Error('Invalid workspace')
  if (typeof request.folder !== 'string' || !path.isAbsolute(request.folder)) throw new Error('Invalid folder')
  const { workspaceId, folder } = request as { workspaceId: string; folder: string }

  // Workspace trust (design §12.12): nothing syncs until the person agrees, for this folder.
  const { response } = await dialog.showMessageBox(window!, {
    type: 'warning',
    buttons: ['Trust and sync', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Sync this workspace into a local folder?',
    detail:
      `Teammates' changes will be written into ${folder}.\n\n` +
      'Converge never runs files that arrive, and never writes into .git, but tools you run in this folder ' +
      '(build scripts, editor tasks) may execute them. Only sync workspaces whose members you trust. ' +
      'Remote deletes are moved to .converge/trash, never erased.',
  })
  if (response !== 0) return { started: false }

  await stopSync()
  const cookies = Object.fromEntries(
    (await session.defaultSession.cookies.get({ url: SERVER.origin })).map((c) => [c.name, c.value]),
  )
  if (!cookies.CONVERGE_SESSION) throw new Error('Sign in before syncing')
  const remote = new HttpRemoteWorkspace({ baseUrl: SERVER.origin, workspaceId, cookies })
  const bridge = new SyncBridge({ root: folder, remote, onEvent: send })
  await bridge.start()
  running = { workspaceId, folder, bridge, remote }
  return { started: true }
})

ipcMain.handle('sync:stop', async (event) => {
  fromApp(event)
  await stopSync()
})

ipcMain.handle('sync:status', (event) => {
  fromApp(event)
  return running ? { workspaceId: running.workspaceId, folder: running.folder } : null
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void stopSync().finally(() => {
    if (process.platform !== 'darwin') app.quit()
  })
})
