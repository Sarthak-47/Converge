import { execFile } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
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
/**
 * End-to-end test hook: native folder pickers and message boxes cannot be automated, so when this variable
 * is set the picker returns it and the trust prompt is skipped for that exact folder only. Only whoever
 * launches the app can set it.
 */
const E2E_SYNC_FOLDER = process.env.CONVERGE_E2E_SYNC_FOLDER ? path.resolve(process.env.CONVERGE_E2E_SYNC_FOLDER) : null

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
  if (E2E_SYNC_FOLDER) return E2E_SYNC_FOLDER
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
  const trustedByTest = E2E_SYNC_FOLDER !== null && path.resolve(folder) === E2E_SYNC_FOLDER
  const { response } = trustedByTest ? { response: 0 } : await dialog.showMessageBox(window!, {
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

/** Runs git in the member's own checkout, with their own config and credentials (design §12.8). */
function gitIn(folder: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: folder, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().split('\n').slice(-2).join(' ')))
      else resolve(stdout)
    })
  })
}

/**
 * Commit and push from the local checkout (design §12.8): first the bridge settles, so every edit typed in the
 * app is on disk and every disk change has been sent; the commit then contains exactly what the team sees.
 * Converge's own state folder is kept out of Git.
 */
ipcMain.handle('git:commit-push', async (event, request: { message?: unknown }) => {
  fromApp(event)
  if (!running) throw new Error('Start syncing to a folder first')
  const message = typeof request?.message === 'string' ? request.message.trim() : ''
  if (!message || message.length > 2000) throw new Error('A commit needs a message')
  const { bridge, folder } = running
  await bridge.idle()
  try {
    await gitIn(folder, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    throw new Error('This folder is not a Git checkout. Clone the repository here, or run git init, first.')
  }
  const exclude = path.resolve(folder, (await gitIn(folder, ['rev-parse', '--git-path', 'info/exclude'])).trim())
  const excluded = await readFile(exclude, 'utf8').catch(() => '')
  if (!excluded.split(/\r?\n/).includes('.converge/')) await appendFile(exclude, `${excluded.endsWith('\n') || !excluded ? '' : '\n'}.converge/\n`)

  await gitIn(folder, ['add', '-A'])
  const staged = (await gitIn(folder, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean)
  if (staged.length === 0) return { committed: false, pushed: false, files: 0, detail: 'Nothing to commit' }
  await gitIn(folder, ['commit', '-q', '-m', message])
  const sha = (await gitIn(folder, ['rev-parse', '--short', 'HEAD'])).trim()
  const remotes = (await gitIn(folder, ['remote'])).split('\n').filter(Boolean)
  if (remotes.length === 0) return { committed: true, pushed: false, sha, files: staged.length, detail: 'No remote to push to' }
  const upstream = await gitIn(folder, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => null)
  await gitIn(folder, upstream ? ['push', '-q'] : ['push', '-q', '-u', remotes.includes('origin') ? 'origin' : remotes[0]!, 'HEAD'])
  return { committed: true, pushed: true, sha, files: staged.length, detail: '' }
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
