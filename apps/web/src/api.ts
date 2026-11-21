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
  updateWorkspace: (id: string, change: { name?: string; status?: Workspace['status'] }) =>
    request<Workspace>('PATCH', `/workspaces/${id}`, change),

  tree: (workspaceId: string) => request<FileNode[]>('GET', `/workspaces/${workspaceId}/tree`),
  createFile: (workspaceId: string, parentId: string | null, name: string, kind: FileKind) =>
    request<FileNode>('POST', '/files', { workspaceId, parentId, name, kind }),
  renameFile: (file: FileNode, name: string) =>
    request<FileNode>('PATCH', `/files/${file.id}`, { name, rowVersion: file.rowVersion }),
  /** Moves a file or folder into `parentId`, or to the top level when it is null. */
  moveFile: (file: FileNode, parentId: string | null) =>
    request<FileNode>('PATCH', `/files/${file.id}`, parentId === null ? { moveToRoot: true, rowVersion: file.rowVersion } : { parentId, rowVersion: file.rowVersion }),
  deleteFile: (file: FileNode) => request<void>('DELETE', `/files/${file.id}?rowVersion=${file.rowVersion}`),
  content: (fileId: string) => request<Content>('GET', `/files/${fileId}/content`),
  save: (fileId: string, text: string, baseVersion: number) =>
    request<Content>('PUT', `/files/${fileId}/content`, { text, baseVersion }),

  ticket: (fileId: string) => request<{ ticket: string; expiresAt: string }>('POST', '/realtime/tickets', { fileId }),

  members: (workspaceId: string) => request<Roster>('GET', `/workspaces/${workspaceId}/members`),
  addMember: (workspaceId: string, email: string, role: Role) =>
    request<{ member: Member | null; invitation: Invitation | null }>('POST', `/workspaces/${workspaceId}/members`, { email, role }),
  changeRole: (workspaceId: string, userId: string, role: Role) =>
    request<Member>('PATCH', `/workspaces/${workspaceId}/members/${userId}`, { role }),
  removeMember: (workspaceId: string, userId: string) => request<void>('DELETE', `/workspaces/${workspaceId}/members/${userId}`),
  cancelInvitation: (workspaceId: string, invitationId: string) =>
    request<void>('DELETE', `/workspaces/${workspaceId}/invitations/${invitationId}`),

  history: (fileId: string) => request<Version[]>('GET', `/files/${fileId}/history`),
  checkpoint: (fileId: string, label?: string) => request<Version>('POST', `/files/${fileId}/snapshots`, { label }),
  snapshotText: (fileId: string, snapshotId: string) =>
    request<{ id: string; versionNo: number; text: string }>('GET', `/files/${fileId}/snapshots/${snapshotId}`),
  restore: (fileId: string, snapshotId: string) => request<Version>('POST', `/files/${fileId}/restore`, { snapshotId }),

  chatHistory: (workspaceId: string) => request<ChatHistoryEntry[]>('GET', `/workspaces/${workspaceId}/chat`),

  agentKey: () => request<AgentKey>('GET', '/me/provider-keys/anthropic'),
  agentSpend: () => request<{ spentMicros: number; dailyCapMicros: number; turnCapMicros: number }>('GET', '/me/agent-spend'),
  setAgentKey: (apiKey: string) => request<AgentKey>('PUT', '/me/provider-keys/anthropic', { apiKey }),
  removeAgentKey: () => request<void>('DELETE', '/me/provider-keys/anthropic'),
  agentTurns: (workspaceId: string) => request<AgentTurn[]>('GET', `/workspaces/${workspaceId}/agent/turns`),
  promptAgent: (workspaceId: string, prompt: string, sessionId?: string) =>
    request<AgentTurn>('POST', `/workspaces/${workspaceId}/agent/turns`, { prompt, sessionId }),
  steerTurn: (workspaceId: string, turnId: string, text: string) =>
    request<AgentTurn>('POST', `/workspaces/${workspaceId}/agent/turns/${turnId}/steer`, { text }),

  sessions: (workspaceId: string) => request<SessionCard[]>('GET', `/workspaces/${workspaceId}/sessions`),
  createSession: (workspaceId: string, task: string) => request<SessionCard>('POST', `/workspaces/${workspaceId}/sessions`, { task }),
  session: (sessionId: string) => request<SessionDetail>('GET', `/sessions/${sessionId}`),
  joinSession: (sessionId: string, mode: 'LANE' | 'WATCH') => request<SessionCard>('POST', `/sessions/${sessionId}/join`, { mode }),
  leaveSession: (sessionId: string) => request<SessionCard>('POST', `/sessions/${sessionId}/leave`),
  takeOver: (sessionId: string, rowVersion: number, guidance?: string) =>
    request<AgentTurn>('POST', `/sessions/${sessionId}/takeover`, { rowVersion, guidance }),
  handOff: (sessionId: string, toUserId: string, rowVersion: number) =>
    request<SessionCard>('POST', `/sessions/${sessionId}/handoff`, { toUserId, rowVersion }),
  finishSession: (sessionId: string, rowVersion: number) => request<SessionCard>('POST', `/sessions/${sessionId}/finish`, { rowVersion }),
  addSteps: (sessionId: string, titles: string[]) => request<PlanStep[]>('POST', `/sessions/${sessionId}/steps`, { titles }),
  takeStep: (step: PlanStep) => request<PlanStep>('POST', `/steps/${step.id}/take`, { rowVersion: step.rowVersion }),
  updateStep: (step: PlanStep, status: StepStatus, release = false) =>
    request<PlanStep>('PATCH', `/steps/${step.id}`, { status, release, rowVersion: step.rowVersion }),

  approvals: (workspaceId: string, sessionId?: string) =>
    request<Approval[]>('GET', `/workspaces/${workspaceId}/approvals${sessionId ? `?sessionId=${sessionId}` : ''}`),
  decide: (approval: Approval, approve: boolean) =>
    request<Approval>('POST', `/approvals/${approval.id}/decide`, { approve, rowVersion: approval.rowVersion }),
  job: (jobId: string) => request<JobDetail>('GET', `/jobs/${jobId}`),
  recordOutcome: (jobId: string, outcome: 'SUCCEEDED' | 'FAILED') => request<Job>('POST', `/jobs/${jobId}/outcome`, { outcome }),
  runCommand: (workspaceId: string, command: string) => request<Approval>('POST', `/workspaces/${workspaceId}/jobs`, { command }),

  memories: (workspaceId: string, fileId?: string) =>
    request<Memory[]>('GET', `/workspaces/${workspaceId}/memories${fileId ? `?fileId=${fileId}` : ''}`),
  createMemory: (workspaceId: string, memory: { fileId: string; kind: MemoryKind; body: string; anchor: Anchor; anchoredText: string }) =>
    request<Memory>('POST', `/workspaces/${workspaceId}/memories`, memory),
  updateMemory: (memory: Memory, body: string) => request<Memory>('PATCH', `/memories/${memory.id}`, { body, rowVersion: memory.rowVersion }),
  retireMemory: (memory: Memory) => request<Memory>('PATCH', `/memories/${memory.id}`, { retire: true }),
  locks: (workspaceId: string, fileId?: string) =>
    request<RangeLock[]>('GET', `/workspaces/${workspaceId}/locks${fileId ? `?fileId=${fileId}` : ''}`),
  holdRange: (workspaceId: string, lock: { fileId: string; anchor: Anchor; quote: string; reason: string }) =>
    request<RangeLock>('POST', `/workspaces/${workspaceId}/locks`, lock),
  releaseLock: (lockId: string) => request<void>('DELETE', `/locks/${lockId}`),
  gitRepository: async (workspaceId: string) =>
    (await request<GitRepository | undefined>('GET', `/workspaces/${workspaceId}/git`)) ?? null,
  connectGit: (workspaceId: string, repo: { remoteUrl: string; defaultBranch: string; token: string }) =>
    request<GitRepository>('PUT', `/workspaces/${workspaceId}/git`, repo),
  disconnectGit: (workspaceId: string) => request<void>('DELETE', `/workspaces/${workspaceId}/git`),
  /** Turns on importing pushes automatically; the secret is returned this once. */
  enableGitWebhook: (workspaceId: string) => request<{ path: string; secret: string }>('POST', `/workspaces/${workspaceId}/git/webhook`),
  disableGitWebhook: (workspaceId: string) => request<void>('DELETE', `/workspaces/${workspaceId}/git/webhook`),
  gitOperations: (workspaceId: string, sessionId?: string) =>
    request<GitOperation[]>('GET', `/workspaces/${workspaceId}/git/operations${sessionId ? `?sessionId=${sessionId}` : ''}`),
  importRepository: (workspaceId: string, idempotencyKey: string) =>
    request<GitOperation>('POST', `/workspaces/${workspaceId}/git/pulls`, { idempotencyKey }),
  openPullRequest: (sessionId: string, idempotencyKey: string) =>
    request<GitOperation>('POST', `/sessions/${sessionId}/pull-request`, { idempotencyKey }),
  overlaps: (sessionId: string) => request<Overlap[]>('GET', `/sessions/${sessionId}/overlaps`),

  comments: (workspaceId: string, filter: { fileId?: string; sessionId?: string }) => {
    const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as Array<[string, string]>)
    return request<Comment[]>('GET', `/workspaces/${workspaceId}/comments?${query}`)
  },
  addComment: (workspaceId: string, comment: NewComment) => request<Comment>('POST', `/workspaces/${workspaceId}/comments`, comment),
  resolveComment: (workspaceId: string, commentId: string, resolved: boolean) =>
    request<Comment>('POST', `/workspaces/${workspaceId}/comments/${commentId}/resolve`, { resolved }),
  commentToStep: (workspaceId: string, commentId: string) =>
    request<Comment>('POST', `/workspaces/${workspaceId}/comments/${commentId}/to-step`),
  commentToPrompt: (workspaceId: string, commentId: string) =>
    request<AgentTurn>('POST', `/workspaces/${workspaceId}/comments/${commentId}/to-prompt`),
  cancelTurn: (workspaceId: string, turnId: string) =>
    request<AgentTurn>('POST', `/workspaces/${workspaceId}/agent/turns/${turnId}/cancel`),
  revertTurn: (workspaceId: string, turnId: string) =>
    request<AgentTurn>('POST', `/workspaces/${workspaceId}/agent/turns/${turnId}/revert`),
}

export type Member = { userId: string; email: string; displayName: string; role: Role; joinedAt: string }

export type Invitation = { id: string; email: string; role: Role; createdAt: string }

export type Roster = { members: Member[]; invitations: Invitation[] }

export type Version = {
  id: string
  versionNo: number
  reason: 'MANUAL' | 'AUTO' | 'PRE_EXTERNAL'
  label: string | null
  createdBy: string | null
  createdByName: string | null
  createdAt: string
  contentHash: string
}

export type ChatHistoryEntry = {
  id: string
  workspaceId: string
  userId: string
  displayName: string
  body: string
  createdAt: string
}

export type AgentKey = { configured: boolean; hint: string | null }

export type AgentEvent = {
  seq: number
  kind: 'prompt' | 'text' | 'note' | 'tool' | 'steer' | 'approval'
  text?: string
  name?: string
  summary?: string
  ok?: boolean
  approvalId?: string
}

export type AgentTurnStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUSED' | 'BUDGET_EXCEEDED'

/** One agent turn: exactly one sponsor, who pays for it with their own key (design §13.5). */
export type AgentTurn = {
  id: string
  sessionId: string | null
  laneUserId: string
  sponsorId: string
  sponsorName: string
  model: string
  status: AgentTurnStatus
  error: string | null
  costMicros: number
  costCapMicros: number
  startedAt: string
  endedAt: string | null
  revertStatus: 'REVERTING' | 'REVERTED' | null
  revertible: boolean
  events: AgentEvent[]
}

export type StepStatus = 'TODO' | 'IN_PROGRESS' | 'DONE'

/** A plan step: always owned by a person (or free to take), never by an agent (design §13.9). */
export type PlanStep = {
  id: string
  position: number
  title: string
  ownerId: string | null
  ownerName: string | null
  status: StepStatus
  rowVersion: number
}

export type SessionStatus = 'ACTIVE' | 'AWAITING_TAKEOVER' | 'DONE'

export type SessionCard = {
  id: string
  task: string
  status: SessionStatus
  driverId: string
  driverName: string
  rowVersion: number
  participants: Array<{ userId: string; displayName: string; mode: 'LANE' | 'WATCH' }>
  stepsDone: number
  stepsTotal: number
  files: string[]
  runningTurns: number
  createdAt: string
  endedAt: string | null
}

export type SessionDetail = { session: SessionCard; plan: PlanStep[]; turns: AgentTurn[] }

/** A Yjs relative position as JSON; the server stores it as-is. */
export type Anchor = { start: unknown; end: unknown }

export type CommentTarget = 'FILE_RANGE' | 'TURN' | 'PLAN_STEP'

export type Comment = {
  id: string
  sessionId: string | null
  targetKind: CommentTarget
  fileId: string | null
  turnId: string | null
  stepId: string | null
  anchor: Anchor | null
  quote: string | null
  body: string
  status: 'OPEN' | 'RESOLVED'
  createdBy: string
  authorName: string
  createdAt: string
  causedStepId: string | null
  causedTurnId: string | null
}

export type NewComment = {
  targetKind: CommentTarget
  sessionId?: string | null
  fileId?: string
  turnId?: string
  stepId?: string
  anchor?: Anchor
  quote?: string
  body: string
}

export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'OUTCOME_UNKNOWN'

export type Job = {
  id: string
  approvalId: string
  command: string
  status: JobStatus
  exitCode: number | null
  error: string | null
  outcome: 'SUCCEEDED' | 'FAILED' | null
  createdAt: string
  startedAt: string | null
  endedAt: string | null
}

export type JobDetail = { job: Job; output: Array<{ seq: number; stream: 'stdout' | 'stderr' | 'system'; chunk: string }> }

/** A card that authorizes one exact action once (design §13.7). */
export type Approval = {
  id: string
  sessionId: string | null
  turnId: string | null
  requestedBy: string
  requesterName: string
  command: string
  capabilities: string[]
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED'
  decidedBy: string | null
  deciderName: string | null
  rowVersion: number
  expiresAt: string
  createdAt: string
  job: Job | null
}

export type MemoryKind = 'DECISION' | 'GOTCHA' | 'CONVENTION' | 'NOTE'

/** A note pinned to code (design §13.10); STALE when its code was deleted or rewritten. */
export type Memory = {
  id: string
  fileId: string
  path: string
  kind: MemoryKind
  body: string
  anchor: Anchor
  anchoredText: string
  currentText: string | null
  similarity: number | null
  status: 'ACTIVE' | 'STALE' | 'RETIRED'
  createdBy: string
  authorName: string
  createdInTurn: string | null
  rowVersion: number
  updatedAt: string
}

/** A range a person holds for a while; agents stay out of it (design §13.11). */
export type RangeLock = {
  id: string
  fileId: string
  path: string
  anchor: Anchor
  quote: string
  reason: string
  holderId: string
  holderName: string
  expiresAt: string
}

export type Overlap = { sessionId: string; task: string; driverName: string; status: string; files: string[] }

export type GitRepository = {
  /** Pushes to the default branch are imported automatically (a GitHub webhook is set up). */
  webhook: boolean
  remoteUrl: string
  defaultBranch: string
  owner: string
  repo: string
  credentialHint: string
  connectedByName: string
  updatedAt: string
}

/** An asynchronous Git operation run by the worker (design §10.3). */
export type GitOperation = {
  id: string
  sessionId: string | null
  type: 'PULL_REQUEST' | 'PUSH_BRANCH' | 'PULL'
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  requesterName: string
  params: { branch: string; title?: string; message: string }
  result: {
    branch: string
    sha: string
    changedFiles: number
    prUrl?: string
    prNumber?: number
    created?: number
    updated?: number
    unchanged?: number
    skipped?: string[]
  } | null
  error: string | null
  log: string | null
  createdAt: string
  endedAt: string | null
}
