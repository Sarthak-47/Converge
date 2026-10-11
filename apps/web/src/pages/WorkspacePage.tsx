import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { api, type FileKind, type FileNode, type Workspace } from '../api.ts'
import { useAuth } from '../auth.tsx'
import { ChatPanel } from '../components/ChatPanel.tsx'
import { FileTree } from '../components/FileTree.tsx'
import { TopBar } from '../components/TopBar.tsx'
import { CollabDocument, type SyncState } from '../editor/collabDocument.ts'
import { monaco } from '../editor/monaco.ts'
import { useWorkspaceChannel, type ChatMessage, type WorkspaceEvent } from '../realtime/workspaceChannel.ts'

const CodeEditor = lazy(() => import('../editor/CodeEditor.tsx'))

/** An opened file: its live replica plus the Monaco model that shows it. Kept in a ref; read by handlers. */
type OpenFile = { live: CollabDocument; model: monaco.editor.ITextModel }

const SYNC_LABEL: Record<SyncState, string> = {
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  saving: 'Saving…',
  saved: 'All changes saved',
  offline: 'Offline · changes will sync when reconnected',
  denied: 'You no longer have access to this file',
}

function modelUri(file: FileNode) {
  return monaco.Uri.from({ scheme: 'inmemory', authority: 'converge', path: `/${file.id}/${file.name}` })
}

export default function WorkspacePage() {
  const { workspaceId = '' } = useParams()
  const { user } = useAuth()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [files, setFiles] = useState<FileNode[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const openFiles = useRef(new Map<string, OpenFile>())
  const [active, setActive] = useState<{ id: string; open: OpenFile } | null>(null)
  const [syncStates, setSyncStates] = useState<Record<string, SyncState>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatMessage[]>([])

  const canEdit = workspace?.role === 'OWNER' || workspace?.role === 'EDITOR'
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
  }

  /** Applies another client's tree change. Content changes arrive through each file's live replica. */
  async function onRemoteEvent(event: WorkspaceEvent) {
    if (event.type === 'FILE_SAVED') return
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
    onError: (m) => setMessage(m),
  })

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
      </TopBar>
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
        {active ? (
          <Suspense fallback={<div className="center muted">Loading editor…</div>}>
            <CodeEditor model={active.open.model} live={active.open.live} readOnly={!canEdit || activeState === 'denied'} />
          </Suspense>
        ) : (
          <div className="center muted">{files.length ? 'Select a file to start editing.' : 'Create a file to start editing.'}</div>
        )}
      </section>
      <ChatPanel
        messages={chat}
        currentUserId={user?.id}
        canPost={workspace !== null && workspace.role !== 'VIEWER'}
        connected={channel.state === 'connected'}
        onSend={channel.sendChat}
      />
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
