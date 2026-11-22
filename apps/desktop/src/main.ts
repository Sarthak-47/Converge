import { execFile } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { HttpRemoteWorkspace, SyncBridge, type BridgeEvent } from '@converge/sync-bridge'
import { loadServer, parseServer, probeServer, saveServer } from './serverConfig.js'

/**
 * The desktop app (design §12): the same web client as the browser, plus a sync bridge in this main process
 * that keeps a local checkout in live two-way sync with the open workspace.
 */
/** The Converge server this app opens; null until the person has connected to one (see serverConfig.ts). */
let SERVER: URL | null = null
const here = path.dirname(fileURLToPath(import.meta.url))
const CONNECT_PAGE = path.join(here, '..', 'assets', 'connect.html')

function server(): URL {
  if (!SERVER) throw new Error('Connect to a Converge server first')
  return SERVER
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * End-to-end test hook: native folder pickers and message boxes cannot be automated, so when this variable
 * is set the picker returns it and the trust prompt is skipped for that exact folder only. Only whoever
 * launches the app can set it.
 */
const E2E_SYNC_FOLDER = process.env.CONVERGE_E2E_SYNC_FOLDER ? path.resolve(process.env.CONVERGE_E2E_SYNC_FOLDER) : null

type Running = {
  workspaceId: string
  folder: string
  bridge: SyncBridge | null
  remote: HttpRemoteWorkspace
  /** The branch this folder must be on for sync to run; null when the folder is not a Git checkout. */
  expectedBranch: string | null
  /** Why sync is paused, e.g. another branch is checked out; null while syncing. */
  paused: string | null
  watchBranch: NodeJS.Timeout | null
}

// The app's own data folder (%APPDATA%Converge on Windows), not one named after the npm package. Tests point
// CONVERGE_USER_DATA at a throwaway folder; only whoever launches the app can set it.
app.setPath('userData', process.env.CONVERGE_USER_DATA ? path.resolve(process.env.CONVERGE_USER_DATA) : path.join(app.getPath('appData'), 'Converge'))

let window: BrowserWindow | null = null
let running: Running | null = null

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Converge',
    // The window and taskbar icon (Windows and Linux; macOS uses the app bundle's icon).
    icon: path.join(here, '..', 'assets', 'icon.png'),
    // The app's dark ink, so the window does not flash white before the page paints.
    backgroundColor: '#111214',
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
    if (!SERVER || new URL(url).origin !== SERVER.origin) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
  window.on('closed', () => {
    window = null
  })
  if (SERVER) void window.loadURL(SERVER.href)
  else void window.loadFile(CONNECT_PAGE)
}

/** Shows the "connect to a server" screen, to set the server or change it. */
function showConnect() {
  if (!window) createWindow()
  else void window.loadFile(CONNECT_PAGE)
}

/** The connect screen's calls must come from that local page, never from a server's page. */
function fromConnectPage(event: IpcMainInvokeEvent) {
  if (event.senderFrame?.url !== pathToFileURL(CONNECT_PAGE).href) throw new Error('Only the connect screen can change the server')
}

ipcMain.handle('server:current', (event) => {
  fromConnectPage(event)
  return SERVER?.origin ?? null
})

ipcMain.handle('server:connect', async (event, address: unknown) => {
  fromConnectPage(event)
  const parsed = parseServer(typeof address === 'string' ? address : '')
  if ('error' in parsed) return { ok: false, error: parsed.error }
  const probe = await probeServer(parsed.url)
  if (!probe.ok) return probe
  await saveServer(app.getPath('userData'), parsed.url)
  // Sync belongs to a workspace on the old server; it stops before the app opens the new one.
  if (SERVER?.origin !== parsed.url.origin) await stopSync()
  SERVER = parsed.url
  void window?.loadURL(SERVER.href)
  return { ok: true }
})

function applicationMenu(): Menu {
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Change server…', click: () => showConnect() },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  return Menu.buildFromTemplate(template)
}

/** Every IPC call must come from the Converge page itself, never from other content. */
function fromApp(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url
  if (!url || !SERVER || new URL(url).origin !== SERVER.origin) throw new Error('IPC is only available to the Converge app')
}

type SyncNotice = BridgeEvent | { type: 'paused'; path: string; reason: string } | { type: 'resumed'; path: string }

function send(event: SyncNotice) {
  window?.webContents.send('sync:event', event)
}

async function stopSync() {
  if (!running) return
  const { bridge, remote, watchBranch } = running
  running = null
  if (watchBranch) clearInterval(watchBranch)
  await bridge?.stop()
  await remote.destroy()
}

async function currentBranch(folder: string): Promise<string | null> {
  try {
    // symbolic-ref also works on a branch with no commits yet, where rev-parse HEAD fails.
    return (await gitIn(folder, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim()
  } catch {
    try {
      await gitIn(folder, ['rev-parse', '--git-dir'])
      return 'a detached HEAD' // a Git checkout, but on no branch
    } catch {
      return null // not a Git checkout
    }
  }
}

/**
 * Branch mismatch pauses sync (design §12.8): if the member checks out another branch, that branch's files
 * must not flow into the live documents, nor the workspace's text into that branch. Pausing stops the
 * bridge, which keeps its saved bases; switching back restarts it, which merges whatever changed on disk
 * meanwhile the same way as edits made while the app was closed.
 */
async function checkBranch() {
  const sync = running
  if (!sync || !sync.expectedBranch) return
  const branch = await currentBranch(sync.folder)
  if (running !== sync || branch === null) return
  if (branch !== sync.expectedBranch && !sync.paused) {
    sync.paused = mismatch(branch, sync.expectedBranch)
    const bridge = sync.bridge
    sync.bridge = null
    await bridge?.stop()
    send({ type: 'paused', path: '', reason: sync.paused })
  } else if (branch === sync.expectedBranch && sync.paused) {
    sync.paused = null
    const bridge = new SyncBridge({ root: sync.folder, remote: sync.remote, onEvent: send })
    await bridge.start()
    if (running === sync) sync.bridge = bridge
    else await bridge.stop()
    send({ type: 'resumed', path: '' })
  }
}

function mismatch(local: string, expected: string): string {
  return local === 'a detached HEAD'
    ? `The checkout is on a detached HEAD, not the workspace's branch "${expected}"`
    : `The local branch "${local}" differs from the workspace's branch "${expected}"`
}

/** The workspace's branch: its repository's default branch, or the branch checked out when sync started. */
async function expectedBranch(workspaceId: string, folder: string, cookies: Record<string, string>): Promise<string | null> {
  const checkedOut = await currentBranch(folder)
  if (checkedOut === null) return null
  try {
    const response = await fetch(`${server().origin}/api/v1/workspaces/${workspaceId}/git`, {
      headers: { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') },
    })
    if (response.status === 200) return ((await response.json()) as { defaultBranch: string }).defaultBranch
  } catch {
    // The API is unreachable: fall back to the branch that is checked out now.
  }
  return checkedOut
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
    (await session.defaultSession.cookies.get({ url: server().origin })).map((c) => [c.name, c.value]),
  )
  if (!cookies.CONVERGE_SESSION) throw new Error('Sign in before syncing')
  const remote = new HttpRemoteWorkspace({ baseUrl: server().origin, workspaceId, cookies })
  const branch = await expectedBranch(workspaceId, folder, cookies)
  const checkedOut = await currentBranch(folder)
  running = { workspaceId, folder, bridge: null, remote, expectedBranch: branch, paused: null, watchBranch: null }
  if (branch !== null && checkedOut !== branch) {
    running.paused = mismatch(checkedOut ?? 'no branch', branch)
    send({ type: 'paused', path: '', reason: running.paused })
  } else {
    const bridge = new SyncBridge({ root: folder, remote, onEvent: send })
    await bridge.start()
    running.bridge = bridge
  }
  if (branch !== null) running.watchBranch = setInterval(() => void checkBranch().catch(() => undefined), 1500)
  return { started: true, paused: running.paused }
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
  if (running.paused || !running.bridge) throw new Error(`Sync is paused: ${running.paused ?? 'not running'}`)
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
  return running ? { workspaceId: running.workspaceId, folder: running.folder, paused: running.paused } : null
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
})

app.whenReady().then(async () => {
  SERVER = await loadServer(app.getPath('userData'))
  Menu.setApplicationMenu(applicationMenu())
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
