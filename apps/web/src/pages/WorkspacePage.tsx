import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { api, ApiError, type FileKind, type FileNode, type Workspace } from '../api.ts'
import { FileTree } from '../components/FileTree.tsx'
import { TopBar } from '../components/TopBar.tsx'
import { monaco } from '../editor/monaco.ts'

const CodeEditor = lazy(() => import('../editor/CodeEditor.tsx'))

/** Editor bookkeeping for an opened file. Kept in a ref: it changes on every save and is read only by handlers. */
type OpenFile = {
  model: monaco.editor.ITextModel
  /** Server content version this text is based on; sent with saves to detect conflicts. */
  baseVersion: number
  /** Monaco's alternative version id at the last save; differs from the current one while unsaved. */
  savedVersionId: number
}

type SaveState = 'idle' | 'saving' | 'error'

function modelUri(file: FileNode) {
  return monaco.Uri.from({ scheme: 'inmemory', authority: 'converge', path: `/${file.id}/${file.name}` })
}

export default function WorkspacePage() {
  const { workspaceId = '' } = useParams()
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [files, setFiles] = useState<FileNode[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const openFiles = useRef(new Map<string, OpenFile>())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [activeModel, setActiveModel] = useState<monaco.editor.ITextModel | null>(null)
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set())
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [conflict, setConflict] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const canEdit = workspace?.role === 'OWNER' || workspace?.role === 'EDITOR'
  const activeFile = files.find((f) => f.id === activeId) ?? null

  useEffect(() => {
    const opened = openFiles.current
    Promise.all([api.workspace(workspaceId), api.tree(workspaceId)])
      .then(([w, tree]) => {
        setWorkspace(w)
        setFiles(tree)
      })
      .catch((e: Error) => setLoadError(e.message))
    return () => {
      opened.forEach((f) => f.model.dispose())
      opened.clear()
    }
  }, [workspaceId])

  const refreshDirty = useCallback(() => {
    const next = new Set<string>()
    openFiles.current.forEach((f, id) => {
      if (f.model.getAlternativeVersionId() !== f.savedVersionId) next.add(id)
    })
    setDirtyIds((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next))
  }, [])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyIds.size > 0) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirtyIds])

  function activate(fileId: string | null) {
    setActiveId(fileId)
    setActiveModel(fileId ? openFiles.current.get(fileId)?.model ?? null : null)
  }

  async function openFile(file: FileNode) {
    setMessage(null)
    if (!openFiles.current.has(file.id)) {
      try {
        const content = await api.content(file.id)
        const model = monaco.editor.createModel(content.text, content.language ?? undefined, modelUri(file))
        openFiles.current.set(file.id, {
          model,
          baseVersion: content.version,
          savedVersionId: model.getAlternativeVersionId(),
        })
      } catch (e) {
        setMessage(e instanceof Error ? e.message : 'Could not open the file')
        return
      }
    }
    setConflict(null)
    activate(file.id)
  }

  const save = useCallback(async () => {
    const open = activeId ? openFiles.current.get(activeId) : undefined
    if (!activeId || !open || !canEdit) return
    const versionId = open.model.getAlternativeVersionId()
    if (versionId === open.savedVersionId) return
    setSaveState('saving')
    try {
      const saved = await api.save(activeId, open.model.getValue(), open.baseVersion)
      open.baseVersion = saved.version
      open.savedVersionId = versionId
      setSaveState('idle')
      setConflict(null)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(activeId)
        setSaveState('idle')
      } else {
        setSaveState('error')
        setMessage(e instanceof Error ? e.message : 'Save failed')
      }
    }
    refreshDirty()
  }, [activeId, canEdit, refreshDirty])

  /** Conflict resolution, chosen explicitly by the user: keep my text, or take theirs. */
  async function resolveConflict(keep: 'mine' | 'theirs') {
    const open = conflict ? openFiles.current.get(conflict) : undefined
    if (!conflict || !open) return
    const latest = await api.content(conflict)
    if (keep === 'theirs') {
      if (!window.confirm('Replace your unsaved changes with the saved version?')) return
      open.model.setValue(latest.text)
      open.baseVersion = latest.version
      open.savedVersionId = open.model.getAlternativeVersionId()
      setConflict(null)
      refreshDirty()
    } else {
      open.baseVersion = latest.version
      setConflict(null)
      await save()
    }
  }

  async function createFile(parentId: string | null, name: string, kind: FileKind) {
    const node = await api.createFile(workspaceId, parentId, name, kind)
    setFiles((list) => [...list, node])
    if (kind === 'FILE') await openFile(node)
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
    files.filter(removed).forEach((f) => {
      openFiles.current.get(f.id)?.model.dispose()
      openFiles.current.delete(f.id)
    })
    setFiles((list) => list.filter((f) => !removed(f)))
    if (activeId && !openFiles.current.has(activeId)) activate(null)
    refreshDirty()
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

  const isDirty = activeId !== null && dirtyIds.has(activeId)
  const status = !activeFile ? '' : saveState === 'saving' ? 'Saving…' : isDirty ? 'Unsaved changes · Ctrl+S to save' : 'Saved'

  return (
    <div className="ide">
      <TopBar>
        <span className="workspace-name">{workspace?.name ?? '…'}</span>
        {workspace && <span className="role-badge">{workspace.role.toLowerCase()}</span>}
      </TopBar>
      <aside className="sidebar">
        <FileTree
          files={files}
          activeFileId={activeId}
          dirtyIds={dirtyIds}
          canEdit={canEdit}
          onOpen={openFile}
          onCreate={createFile}
          onRename={renameFile}
          onDelete={deleteFile}
        />
      </aside>
      <section className="editor-area">
        {conflict && conflict === activeId && (
          <div className="banner warning" role="alert">
            <span>This file was saved by someone else since you opened it.</span>
            <button type="button" onClick={() => void resolveConflict('mine')}>Overwrite with mine</button>
            <button type="button" className="ghost" onClick={() => void resolveConflict('theirs')}>Load theirs</button>
          </div>
        )}
        {message && <div className="banner error-banner" role="alert">{message}</div>}
        {activeModel ? (
          <Suspense fallback={<div className="center muted">Loading editor…</div>}>
            <CodeEditor model={activeModel} readOnly={!canEdit} onSave={() => void save()} onChange={refreshDirty} />
          </Suspense>
        ) : (
          <div className="center muted">{files.length ? 'Select a file to start editing.' : 'Create a file to start editing.'}</div>
        )}
      </section>
      <footer className="statusbar">
        <span>{activeFile?.path ?? ''}</span>
        <span>{activeFile ? activeFile.language ?? 'plain text' : ''}</span>
        <span className={isDirty ? 'unsaved' : ''}>{status}</span>
      </footer>
    </div>
  )
}
