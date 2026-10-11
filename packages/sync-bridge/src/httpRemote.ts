import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { Client } from '@stomp/stompjs'
import WebSocket from 'ws'
import * as Y from 'yjs'
import type { RemoteEntry, RemoteWorkspace } from './remote.js'

export type HttpRemoteOptions = {
  /** Where the app is served, e.g. http://localhost:8000; the API, /ws and /collab share this origin. */
  baseUrl: string
  workspaceId: string
  /** Cookies of a signed-in session, as name → value (at least CONVERGE_SESSION). */
  cookies: Record<string, string>
}

type TreeNode = { id: string; parentId: string | null; name: string; kind: 'FILE' | 'FOLDER'; path: string; rowVersion: number }

/**
 * The real workspace for the desktop app: the HTTP API for the tree, the collaboration service for live
 * documents (one shared socket, a fresh single-use ticket per connection attempt), and the STOMP channel for
 * tree changes. Uses the same session cookie as the app window, so it acts exactly as the signed-in person.
 */
export class HttpRemoteWorkspace implements RemoteWorkspace {
  private readonly baseUrl: string
  private readonly cookies: Map<string, string>
  private readonly socket: HocuspocusProviderWebsocket
  private readonly providers = new Map<string, { provider: HocuspocusProvider; doc: Y.Doc }>()
  private readonly treeListeners = new Set<() => void>()
  private readonly stomp: Client

  constructor(private readonly options: HttpRemoteOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.cookies = new Map(Object.entries(options.cookies))
    const origin = new URL(this.baseUrl).origin
    const cookieHeader = () => this.cookieHeader()
    // Browsers send Cookie and Origin on the handshake by themselves; in Node they must be added explicitly.
    class SessionWebSocket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { Cookie: cookieHeader(), Origin: origin } })
      }
    }
    const wsBase = this.baseUrl.replace(/^http/, 'ws')
    this.socket = new HocuspocusProviderWebsocket({ url: `${wsBase}/collab`, WebSocketPolyfill: SessionWebSocket })
    this.stomp = new Client({
      webSocketFactory: () => new SessionWebSocket(`${wsBase}/ws`),
      reconnectDelay: 2000,
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      onConnect: () => {
        this.stomp.subscribe(`/topic/workspace/${options.workspaceId}/events`, () => this.treeChanged())
        this.treeChanged() // catch up on anything missed while disconnected
      },
    })
    this.stomp.activate()
  }

  async list(): Promise<RemoteEntry[]> {
    const tree = await this.request<TreeNode[]>('GET', `/api/v1/workspaces/${this.options.workspaceId}/tree`)
    return tree.map(({ id, path, kind }) => ({ id, path, kind }))
  }

  async open(fileId: string): Promise<Y.Doc> {
    const existing = this.providers.get(fileId)
    if (existing) return existing.doc
    const doc = new Y.Doc()
    const synced = new Promise<void>((resolve, reject) => {
      const provider = new HocuspocusProvider({
        websocketProvider: this.socket,
        name: fileId,
        document: doc,
        token: async () => (await this.request<{ ticket: string }>('POST', '/api/v1/realtime/tickets', { fileId })).ticket,
        onSynced: () => resolve(),
        onAuthenticationFailed: ({ reason }) => reject(new Error(`Not allowed to open ${fileId}: ${reason}`)),
      })
      provider.attach()
      this.providers.set(fileId, { provider, doc })
    })
    await synced
    return doc
  }

  close(fileId: string): void {
    const open = this.providers.get(fileId)
    if (!open) return
    open.provider.destroy()
    open.doc.destroy()
    this.providers.delete(fileId)
  }

  /** Creates the file and any missing parent folders, in order. */
  async createFile(path: string): Promise<RemoteEntry> {
    const tree = await this.request<TreeNode[]>('GET', `/api/v1/workspaces/${this.options.workspaceId}/tree`)
    const segments = path.split('/')
    let parentId: string | null = null
    for (let i = 0; i < segments.length - 1; i++) {
      const folderPath = segments.slice(0, i + 1).join('/')
      let folder = tree.find((n) => n.path === folderPath && n.kind === 'FOLDER')
      if (!folder) {
        folder = await this.request<TreeNode>('POST', '/api/v1/files', {
          workspaceId: this.options.workspaceId, parentId, name: segments[i], kind: 'FOLDER',
        })
        tree.push(folder)
      }
      parentId = folder.id
    }
    const file = await this.request<TreeNode>('POST', '/api/v1/files', {
      workspaceId: this.options.workspaceId, parentId, name: segments[segments.length - 1], kind: 'FILE',
    })
    return { id: file.id, path: file.path, kind: file.kind }
  }

  async deleteFile(fileId: string): Promise<void> {
    const tree = await this.request<TreeNode[]>('GET', `/api/v1/workspaces/${this.options.workspaceId}/tree`)
    const node = tree.find((n) => n.id === fileId)
    if (node) await this.request('DELETE', `/api/v1/files/${fileId}?rowVersion=${node.rowVersion}`)
  }

  onTreeChanged(listener: () => void): () => void {
    this.treeListeners.add(listener)
    return () => this.treeListeners.delete(listener)
  }

  async destroy(): Promise<void> {
    for (const fileId of [...this.providers.keys()]) this.close(fileId)
    this.socket.destroy()
    await this.stomp.deactivate()
  }

  private treeChanged() {
    this.treeListeners.forEach((listener) => listener())
  }

  private cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  private remember(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      const expired = attributes.some((a) => /max-age=0/i.test(a.trim())) || value === ''
      if (expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Cookie: this.cookieHeader() }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (method !== 'GET') {
      if (!this.cookies.has('XSRF-TOKEN')) {
        this.remember(await fetch(`${this.baseUrl}/api/v1/auth/csrf`, { headers: { Cookie: this.cookieHeader() } }))
      }
      headers['Cookie'] = this.cookieHeader()
      headers['X-XSRF-TOKEN'] = this.cookies.get('XSRF-TOKEN') ?? ''
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    this.remember(response)
    if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}`)
    return (response.status === 204 ? undefined : await response.json()) as T
  }
}
