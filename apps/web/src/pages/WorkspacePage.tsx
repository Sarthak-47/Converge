import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import { useNavigate, useParams } from 'react-router'
import { api, ApiError, type Anchor, type Comment, type FileKind, type FileNode, type Memory, type MemoryKind, type RangeLock, type Workspace } from '../api.ts'
import { MemoryPanel } from '../components/MemoryPanel.tsx'
import { useAuth } from '../auth.tsx'
import { ChatPanel } from '../components/ChatPanel.tsx'
import { FileTree } from '../components/FileTree.tsx'
import { askText } from '../components/askText.tsx'
import { GitDialog } from '../components/GitDialog.tsx'
import { MembersDialog } from '../components/MembersDialog.tsx'
import { PresenceAvatars } from '../components/PresenceAvatars.tsx'
import { SessionsPanel } from '../components/SessionsPanel.tsx'
import { SyncControl } from '../components/SyncControl.tsx'
import { TopBar } from '../components/TopBar.tsx'
import { CollabDocument, type Peer, type SyncState } from '../editor/collabDocument.ts'
import { monaco } from '../editor/monaco.ts'
import { useWorkspaceChannel, type ChatMessage, type WorkspaceEvent } from '../realtime/workspaceChannel.ts'
import { BrandMark } from '../components/Icon.tsx'

const CodeEditor = lazy(() => import('../editor/CodeEditor.tsx'))
const HistoryView = lazy(() => import('../editor/HistoryView.tsx'))

/** An opened file: its live replica plus the Monaco model that shows it. Kept in a ref; read by handlers. */
type OpenFile = { live: CollabDocument; model: monaco.editor.ITextModel }

const NO_PEERS: Peer[] = []

const SYNC_LABEL: Record<SyncState, string> = {
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  saving: 'Saving…',
  saved: 'All changes saved',
  offline: 'Offline · changes will sync when reconnected',
  denied: 'You no longer have access to this file',
  deleted: 'This file was deleted',
}

function modelUri(file: FileNode) {
  return monaco.Uri.from({ scheme: 'inmemory', authority: 'converge', path: `/${file.id}/${file.name}` })
}

export default function WorkspacePage() {
  const { workspaceId = '' } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [showMembers, setShowMembers] = useState(false)
  const [showGit, setShowGit] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [files, setFiles] = useState<FileNode[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const openFiles = useRef(new Map<string, OpenFile>())
  const [active, setActive] = useState<{ id: string; open: OpenFile } | null>(null)
  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [sideTab, setSideTab] = useState<'chat' | 'sessions' | 'memory'>('chat')
  const [fileNotes, setFileNotes] = useState<Memory[]>([])
  const [fileLocks, setFileLocks] = useState<RangeLock[]>([])
  const [agentSignal, setAgentSignal] = useState(0)
  const [jobSignal, setJobSignal] = useState(0)
  const [openSession, setOpenSession] = useState<string | null>(null)
  const [fileComments, setFileComments] = useState<Comment[]>([])
  const [textTick, setTextTick] = useState(0)
  const [reveal, setReveal] = useState<{ start: number; end: number; key: string } | null>(null)
  const pendingReveal = useRef<string | null>(null)
  const editorInstance = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const editorHost = useRef<HTMLDivElement | null>(null)

  const canEdit = workspace?.role === 'OWNER' || workspace?.role === 'EDITOR'
  const canComment = canEdit || workspace?.role === 'COMMENTER'
  const activeId = active?.id ?? null
  const activeFile = files.find((f) => f.id === activeId) ?? null

  useEffect(() => {
    const opened = openFiles.current
    Promise.all([api.workspace(workspaceId), api.tree(workspaceId), api.chatHistory(workspaceId)])
      .then(([w, tree, history]) => {
        setWorkspace(w)
        setFiles(tree)
        setChat(history.reverse())
      })
      .catch((e: Error) => setLoadError(e.message))
    return () => {
      opened.forEach((f) => {
        f.live.destroy()
        f.model.dispose()
      })
      opened.clear()
    }
  }, [workspaceId])

  const activeLive = active?.open.live
  const peers = useSyncExternalStore(
    useCallback((listener: () => void) => activeLive?.subscribePeers(listener) ?? (() => undefined), [activeLive]),
    () => activeLive?.peers() ?? NO_PEERS,
  )

  const unsyncedIds = new Set(Object.entries(syncStates).filter(([, s]) => s === 'saving' || s === 'offline').map(([id]) => id))

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if ([...openFiles.current.values()].some((f) => f.live.hasUnsyncedChanges)) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const close = useCallback((fileId: string) => {
    const open = openFiles.current.get(fileId)
    if (!open) return
    open.live.destroy()
    open.model.dispose()
    openFiles.current.delete(fileId)
    setSyncStates(({ [fileId]: _closed, ...rest }) => rest)
    setActive((current) => (current?.id === fileId ? null : current))
  }, [])

  function openFile(file: FileNode) {
    if (!user) return
    setMessage(null)
    let open = openFiles.current.get(file.id)
    if (!open) {
      const live = new CollabDocument(file.id, user, (state) => setSyncStates((s) => ({ ...s, [file.id]: state })))
      const model = monaco.editor.createModel('', file.language ?? undefined, modelUri(file))
      open = { live, model }
      openFiles.current.set(file.id, open)
    }
    setActive({ id: file.id, open })
    setShowHistory(false)
  }

  /** Re-reads my role after a membership change; losing access entirely closes the workspace. */
  async function refreshAccess() {
    try {
      setWorkspace(await api.workspace(workspaceId))
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setLoadError('You no longer have access to this workspace.')
    }
  }

  /** Applies another client's change. Content changes arrive through each file's live replica. */
  async function onRemoteEvent(event: WorkspaceEvent) {
    if (event.type === 'FILE_SAVED') return
    if (event.type.startsWith('JOB_')) {
      // Output streams often; only status changes refresh the session view.
      setJobSignal((n) => n + 1)
      if (event.type === 'JOB_UPDATED') setAgentSignal((n) => n + 1)
      return
    }
    if (/^(AGENT|SESSION|COMMENT|APPROVAL|MEMORY|LOCKS|GIT)_/.test(event.type)) {
      setAgentSignal((n) => n + 1)
      return
    }
    if (event.type === 'MEMBER_ADDED' || event.type === 'MEMBER_ROLE_CHANGED' || event.type === 'MEMBER_REMOVED') {
      if (event.payload.userId === user?.id) await refreshAccess()
      return
    }
    const tree = await api.tree(workspaceId)
    setFiles(tree)
    for (const node of tree) {
      const open = openFiles.current.get(node.id)
      if (open && open.model.getLanguageId() !== (node.language ?? 'plaintext')) {
        monaco.editor.setModelLanguage(open.model, node.language ?? 'plaintext')
      }
    }
    if (event.type === 'FILE_DELETED') {
      const deletedActive = activeId !== null && !tree.some((n) => n.id === activeId)
      ;[...openFiles.current.keys()].filter((id) => !tree.some((n) => n.id === id)).forEach(close)
      if (deletedActive) setMessage(`"${event.payload.path}" was deleted by someone else.`)
    }
  }

  const channel = useWorkspaceChannel(workspaceId, {
    onEvent: (event) => void onRemoteEvent(event),
    onChat: (m) => setChat((list) => (list.some((x) => x.id === m.id) ? list : [...list, m])),
    // A rejected resubscription after a reconnect usually means access was just removed.
    onError: (m) => {
      setMessage(m)
      void refreshAccess()
    },
  })

  // Comments anchored to the open file (design §13.9): loaded per file, re-resolved as the text changes.
  useEffect(() => {
    if (!activeId) return
    api.comments(workspaceId, { fileId: activeId }).then(setFileComments).catch(() => setFileComments([]))
    api.memories(workspaceId, activeId).then(setFileNotes).catch(() => setFileNotes([]))
    api.locks(workspaceId, activeId).then(setFileLocks).catch(() => setFileLocks([]))
  }, [workspaceId, activeId, agentSignal])

  useEffect(() => {
    const text = active?.open.live.text
    if (!text) return
    let frame = 0
    const changed = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setTextTick((n) => n + 1))
    }
    text.observe(changed)
    return () => {
      cancelAnimationFrame(frame)
      text.unobserve(changed)
    }
  }, [active])

  const anchored = useMemo(() => {
    void textTick
    const doc = active?.open.live.doc
    if (!doc) return []
    return fileComments.filter((comment) => comment.fileId === activeId).map((comment) => {
      const resolve = (position: unknown) => {
        try {
          return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position), doc)?.index ?? null
        } catch {
          return null
        }
      }
      const start = comment.anchor ? resolve(comment.anchor.start) : null
      const end = comment.anchor ? resolve(comment.anchor.end) : null
      // The anchored text was deleted: the comment stays, labelled outdated (design §13.9).
      const outdated = start === null || end === null || end <= start
      return { comment, start: start ?? 0, end: end ?? 0, outdated }
    })
  }, [fileComments, active, activeId, textTick])

  /** Notes and held ranges on the open file, resolved against its live text. */
  const pinned = useMemo(() => {
    void textTick
    const doc = active?.open.live.doc
    if (!doc) return { notes: [], locks: [] }
    const range = (anchor: Anchor) => {
      const resolve = (position: unknown) => {
        try {
          return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position), doc)?.index ?? null
        } catch {
          return null
        }
      }
      const start = resolve(anchor.start)
      const end = resolve(anchor.end)
      return start === null || end === null || end <= start ? null : { start, end }
    }
    return {
      notes: fileNotes.filter((n) => n.fileId === activeId).map((note) => ({ note, range: range(note.anchor) })),
      locks: fileLocks.filter((l) => l.fileId === activeId).map((lock) => ({ lock, range: range(lock.anchor) })),
    }
  }, [fileNotes, fileLocks, active, activeId, textTick])

  const highlights = useMemo(() => [
    ...anchored.filter((a) => !a.outdated && a.comment.status === 'OPEN')
      .map((a) => ({ start: a.start, end: a.end, title: `${a.comment.authorName}: ${a.comment.body}` })),
    ...pinned.notes.flatMap(({ note, range }) => range ? [{
      ...range, title: `Note (${note.kind.toLowerCase()}${note.status === 'STALE' ? ', stale' : ''}): ${note.body}`,
      className: note.status === 'STALE' ? 'memory-range stale' : 'memory-range',
    }] : []),
    ...pinned.locks.flatMap(({ lock, range }) => range ? [{
      ...range, title: `Held by ${lock.holderName}: ${lock.reason}`, className: 'held-range',
    }] : []),
  ], [anchored, pinned])

  useEffect(() => {
    const target = anchored.find((a) => a.comment.id === pendingReveal.current)
    if (target && !target.outdated) {
      pendingReveal.current = null
      setReveal({ start: target.start, end: target.end, key: target.comment.id })
    }
  }, [anchored])

  function showComment(comment: Comment) {
    const node = files.find((f) => f.id === comment.fileId)
    if (!node) return
    pendingReveal.current = comment.id
    openFile(node)
  }

  /** The editor selection as an anchor that follows the text through every later edit. */
  function selectionAnchor(what: string): { fileId: string; anchor: Anchor; quote: string } | null {
    const instance = editorInstance.current
    const live = active?.open.live
    if (!instance || !live || !activeId) return null
    const selection = instance.getSelection()
    const model = instance.getModel()
    if (!selection || !model || selection.isEmpty()) {
      setMessage(`Select the code you want to ${what} first.`)
      return null
    }
    const start = model.getOffsetAt(selection.getStartPosition())
    const end = model.getOffsetAt(selection.getEndPosition())
    // The end sticks to the character before it, so text typed right after the range does not join it.
    return {
      fileId: activeId,
      anchor: {
        start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(live.text, start, 0)),
        end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(live.text, end, -1)),
      },
      quote: live.text.toString().slice(start, end),
    }
  }

  async function onSelection(what: string, title: string, ask: string, save: (target: { fileId: string; anchor: Anchor; quote: string }, text: string) => Promise<unknown>) {
    const target = selectionAnchor(what)
    if (!target) return
    const text = await askText({ title, label: ask, multiline: true })
    if (!text) return
    try {
      await save(target, text)
      setAgentSignal((n) => n + 1)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : `Could not ${what}`)
    }
  }

  function commentOnSelection() {
    void onSelection('comment on', 'Comment', 'Comment on the selected code', (t, body) =>
      api.addComment(workspaceId, { targetKind: 'FILE_RANGE', sessionId: openSession, fileId: t.fileId, anchor: t.anchor, quote: t.quote, body }))
  }

  /** "gotcha: …", "decision: …" or "convention: …" sets the note's kind. */
  function noteOnSelection() {
    void onSelection('pin a note to', 'Note', 'Note for teammates and agents (start with "decision:", "gotcha:" or "convention:" to set its kind)', (t, text) => {
      const match = /^(decision|gotcha|convention)\s*:\s*/i.exec(text)
      const kind = (match ? match[1]!.toUpperCase() : 'NOTE') as MemoryKind
      return api.createMemory(workspaceId, { fileId: t.fileId, kind, body: match ? text.slice(match[0].length) : text, anchor: t.anchor, anchoredText: t.quote })
    })
  }

  function holdSelection() {
    void onSelection('hold', 'Hold this code', 'Why are you holding this code? Agents will leave it alone for two hours.', (t, reason) =>
      api.holdRange(workspaceId, { fileId: t.fileId, anchor: t.anchor, quote: t.quote, reason }))
  }

  async function createCheckpoint() {
    if (!activeId) return
    const label = await askText({ title: 'Checkpoint', label: 'Name this checkpoint (optional)', optional: true, submitLabel: 'Save checkpoint' })
    if (label === null) return
    try {
      const version = await api.checkpoint(activeId, label || undefined)
      setNotice(`Saved checkpoint v${version.versionNo}.`)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not create a checkpoint')
    }
  }

  async function createFile(parentId: string | null, name: string, kind: FileKind) {
    const node = await api.createFile(workspaceId, parentId, name, kind)
    setFiles((list) => [...list, node])
    if (kind === 'FILE') openFile(node)
  }

  async function renameFile(file: FileNode, name: string) {
    await api.renameFile(file, name)
    const tree = await api.tree(workspaceId)
    setFiles(tree)
    for (const node of tree) {
      const open = openFiles.current.get(node.id)
      if (open && open.model.getLanguageId() !== (node.language ?? 'plaintext')) {
        monaco.editor.setModelLanguage(open.model, node.language ?? 'plaintext')
      }
    }
  }

  async function deleteFile(file: FileNode) {
    await api.deleteFile(file)
    const removed = (f: FileNode) => f.id === file.id || f.path.startsWith(`${file.path}/`)
    files.filter(removed).forEach((f) => close(f.id))
    setFiles((list) => list.filter((f) => !removed(f)))
  }

  // Opening a file slides its text in, once, so the switch reads as a change of document (skipped for reduced motion).
  useEffect(() => {
    const host = editorHost.current
    if (!host || !activeId || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    host.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' })
  }, [activeId])

  if (loadError) {
    return (
      <div className="page">
        <TopBar />
        <main className="content">
          <p className="error" role="alert">{loadError}</p>
        </main>
      </div>
    )
  }

  const activeState = activeId ? syncStates[activeId] ?? 'connecting' : null


  return (
    <div className="ide">
      <TopBar>
        <span className="workspace-name">{workspace?.name ?? '…'}</span>
        {workspace && <span className="role-badge">{workspace.role.toLowerCase()}</span>}
        <span className={`connection ${channel.state}`} title="Realtime connection">
          {channel.state === 'connected' ? 'Live' : channel.state === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
        </span>
        <PresenceAvatars online={channel.online} />
        {workspace && <SyncControl workspaceId={workspace.id} />}
        {workspace && (
          <button type="button" className="ghost" onClick={() => setShowGit(true)}>Repository</button>
        )}
        {workspace && (
          <button type="button" className="ghost" onClick={() => setShowMembers(true)}>Members</button>
        )}
      </TopBar>
      {showGit && workspace && <GitDialog workspace={workspace} refreshSignal={agentSignal} onClose={() => setShowGit(false)} />}
      {showMembers && workspace && user && (
        <MembersDialog workspace={workspace} currentUserId={user.id} onClose={() => setShowMembers(false)} onLeft={() => navigate('/')} />
      )}
      <aside className="sidebar">
        <FileTree
          files={files}
          activeFileId={activeId}
          dirtyIds={unsyncedIds}
          canEdit={canEdit}
          onOpen={openFile}
          onCreate={createFile}
          onRename={renameFile}
          onDelete={deleteFile}
        />
      </aside>
      <section className="editor-area">
        {message && <div className="banner error-banner" role="alert">{message}</div>}
        {active && peers.length > 0 && (
          <div className="editor-peers" aria-label="Also editing this file">
            <span>Also here:</span>
            {peers.map((p) => (
              <span key={p.clientId} className="peer">
                <span className="peer-dot" style={{ background: p.color }} /> {p.name}
              </span>
            ))}
          </div>
        )}
        {notice && (
          <div className="banner notice-banner" role="status">
            <span>{notice}</span>
            <button type="button" className="ghost" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        )}
        {active && (
          <div className="editor-toolbar">
            {canEdit && (
              <button type="button" className="ghost" onClick={() => void createCheckpoint()}>Checkpoint</button>
            )}
            {canComment && (
              <>
                <button type="button" className="ghost" onClick={commentOnSelection}>Comment</button>
                <button type="button" className="ghost" onClick={noteOnSelection}>Note</button>
              </>
            )}
            {canEdit && <button type="button" className="ghost" onClick={holdSelection}>Hold</button>}
            <button type="button" className={showHistory ? 'primary' : 'ghost'} aria-pressed={showHistory} onClick={() => setShowHistory((v) => !v)}>
              History
            </button>
          </div>
        )}
        {active && (pinned.notes.length > 0 || pinned.locks.length > 0) && !showHistory && (
          <ul className="file-comments file-notes" aria-label="Notes on this file">
            {pinned.locks.map(({ lock, range }) => (
              <li key={lock.id}>
                <button type="button" className="link small" disabled={!range}
                  onClick={() => range && setReveal({ ...range, key: `${lock.id}-${Date.now()}` })}>
                  🔒 Held by {lock.holderName}: {lock.reason}
                </button>
              </li>
            ))}
            {pinned.notes.map(({ note, range }) => (
              <li key={note.id} className={note.status === 'STALE' ? 'stale' : ''}>
                <button type="button" className="link small" disabled={!range}
                  onClick={() => range && setReveal({ ...range, key: `${note.id}-${Date.now()}` })}>
                  📌 {note.kind.toLowerCase()}: {note.body}
                </button>
                {note.status === 'STALE' && <span className="muted small"> (stale: its code changed; rewrite or retire it)</span>}
              </li>
            ))}
          </ul>
        )}
        {active && anchored.length > 0 && !showHistory && (
          <ul className="file-comments" aria-label="Comments on this file">
            {anchored.map(({ comment, start, end, outdated }) => (
              <li key={comment.id} className={comment.status === 'RESOLVED' ? 'resolved' : ''}>
                <button type="button" className="link small" disabled={outdated}
                  onClick={() => setReveal({ start, end, key: `${comment.id}-${Date.now()}` })}>
                  💬 {comment.authorName}: {comment.body}
                </button>
                {outdated && <span className="muted small"> (outdated: the code it pointed at was removed)</span>}
                {comment.status === 'RESOLVED' && <span className="muted small"> (resolved)</span>}
              </li>
            ))}
          </ul>
        )}
        {active && showHistory && (
          <Suspense fallback={<div className="center muted">Loading history…</div>}>
            <HistoryView
              fileId={active.id}
              current={active.open.model}
              canRestore={canEdit}
              onClose={() => setShowHistory(false)}
              onRestored={(version) => {
                setShowHistory(false)
                setNotice(`Restored version ${version}. The previous text was saved as a new version.`)
              }}
            />
          </Suspense>
        )}
        {active ? (
          // Stays mounted while history is open, so the binding keeps the live text (and the diff) current.
          <div className="editor-host" hidden={showHistory} ref={editorHost}>
            <Suspense fallback={<div className="center muted">Loading editor…</div>}>
              <CodeEditor
                model={active.open.model}
                live={active.open.live}
                readOnly={!canEdit || activeState === 'denied' || activeState === 'deleted'}
                highlights={highlights}
                reveal={reveal}
                onEditor={(instance) => {
                  editorInstance.current = instance
                }}
              />
            </Suspense>
          </div>
        ) : (
          <div className="center editor-empty">
            <div className="editor-empty-inner">
              <BrandMark size={26} />
              <p className="editor-empty-title">{files.length ? 'Select a file to start editing.' : 'Create a file to start editing.'}</p>
              <p className="muted small">Everyone here types into the same file. Cursors, lanes and turns carry each person's colour.</p>
            </div>
          </div>
        )}
      </section>
      <div className="side-panel">
        <div className="side-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={sideTab === 'chat'} className={sideTab === 'chat' ? 'active' : ''} onClick={() => setSideTab('chat')}>Chat</button>
          <button type="button" role="tab" aria-selected={sideTab === 'sessions'} className={sideTab === 'sessions' ? 'active' : ''} onClick={() => setSideTab('sessions')}>Sessions</button>
          <button type="button" role="tab" aria-selected={sideTab === 'memory'} className={sideTab === 'memory' ? 'active' : ''} onClick={() => setSideTab('memory')}>Memory</button>
        </div>
        {sideTab === 'memory' && workspace && user && (
          <MemoryPanel
            workspaceId={workspaceId}
            currentUserId={user.id}
            role={workspace.role}
            refreshSignal={agentSignal}
            onShow={(fileId) => {
              const node = files.find((f) => f.id === fileId)
              if (node) openFile(node)
            }}
          />
        )}
        {sideTab === 'memory' ? null : sideTab === 'chat' ? (
          <ChatPanel
            messages={chat}
            currentUserId={user?.id}
            canPost={workspace !== null && workspace.role !== 'VIEWER'}
            connected={channel.state === 'connected'}
            onSend={channel.sendChat}
          />
        ) : (
          user && workspace && (
            <SessionsPanel
              workspaceId={workspaceId}
              currentUser={user}
              role={workspace.role}
              refreshSignal={agentSignal}
              jobSignal={jobSignal}
              sessionId={openSession}
              onOpenSession={setOpenSession}
              onShowComment={showComment}
            />
          )
        )}
      </div>
      <footer className="statusbar">
        <span>{activeFile?.path ?? ''}</span>
        <span>{activeFile ? activeFile.language ?? 'plain text' : ''}</span>
        <span className={activeState === 'offline' || activeState === 'denied' ? 'unsaved' : ''} data-sync={activeState ?? ''}>
          {activeState ? SYNC_LABEL[activeState] : ''}
        </span>
      </footer>
    </div>
  )
}
