/** Typed client for the Converge API. Same-origin requests carry the session cookie automatically. */

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type User = { id: string; email: string; displayName: string }

export type Role = 'OWNER' | 'EDITOR' | 'COMMENTER' | 'VIEWER'

export type Workspace = { id: string; name: string; slug: string; status: 'ACTIVE' | 'ARCHIVED'; role: Role }

export type FileKind = 'FILE' | 'FOLDER'

export type FileNode = {
  id: string
  workspaceId: string
  parentId: string | null
  name: string
  kind: FileKind
  path: string
  language: string | null
  rowVersion: number
}

export type Content = { fileId: string; path: string; language: string | null; text: string; version: number }

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

function readCsrfCookie(): string | undefined {
  const entry = document.cookie.split('; ').find((c) => c.startsWith('XSRF-TOKEN='))
  return entry ? decodeURIComponent(entry.slice('XSRF-TOKEN='.length)) : undefined
}

async function csrfToken(refresh: boolean): Promise<string | undefined> {
  if (refresh || !readCsrfCookie()) {
    await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' })
  }
  return readCsrfCookie()
}

async function send(method: Method, path: string, body: unknown, refreshCsrf: boolean): Promise<Response> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') {
    const token = await csrfToken(refreshCsrf)
    if (token) headers['X-XSRF-TOKEN'] = token
  }
  return fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
}

export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let response = await send(method, path, body, false)
  // Spring Security rotates the CSRF token at sign-in; one retry with a fresh token covers that.
  if (response.status === 403 && method !== 'GET') {
    response = await send(method, path, body, true)
  }
  if (!response.ok) {
    let message = response.statusText || `Request failed (${response.status})`
    try {
      const problem = (await response.json()) as { detail?: string; title?: string }
      message = problem.detail ?? problem.title ?? message
    } catch {
      // Not a problem-details body; keep the status text.
    }
    throw new ApiError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  me: () => request<User>('GET', '/auth/me'),
  login: (email: string, password: string) => request<User>('POST', '/auth/login', { email, password }),
  register: (email: string, displayName: string, password: string) =>
    request<User>('POST', '/auth/register', { email, displayName, password }),
  logout: () => request<void>('POST', '/auth/logout'),

  workspaces: () => request<Workspace[]>('GET', '/workspaces'),
  workspace: (id: string) => request<Workspace>('GET', `/workspaces/${id}`),
  createWorkspace: (name: string) => request<Workspace>('POST', '/workspaces', { name }),

  tree: (workspaceId: string) => request<FileNode[]>('GET', `/workspaces/${workspaceId}/tree`),
  createFile: (workspaceId: string, parentId: string | null, name: string, kind: FileKind) =>
    request<FileNode>('POST', '/files', { workspaceId, parentId, name, kind }),
  renameFile: (file: FileNode, name: string) =>
    request<FileNode>('PATCH', `/files/${file.id}`, { name, rowVersion: file.rowVersion }),
  deleteFile: (file: FileNode) => request<void>('DELETE', `/files/${file.id}?rowVersion=${file.rowVersion}`),
  content: (fileId: string) => request<Content>('GET', `/files/${fileId}/content`),
  save: (fileId: string, text: string, baseVersion: number) =>
    request<Content>('PUT', `/files/${fileId}/content`, { text, baseVersion }),
}
