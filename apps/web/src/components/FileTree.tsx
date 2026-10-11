import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { FileKind, FileNode } from '../api.ts'

type TreeNode = FileNode & { children: TreeNode[] }

type Props = {
  files: FileNode[]
  activeFileId: string | null
  dirtyIds: Set<string>
  canEdit: boolean
  onOpen: (file: FileNode) => void
  onCreate: (parentId: string | null, name: string, kind: FileKind) => Promise<void>
  onRename: (file: FileNode, name: string) => Promise<void>
  onDelete: (file: FileNode) => Promise<void>
}

type Draft = { kind: 'create'; parentId: string | null; fileKind: FileKind } | { kind: 'rename'; file: FileNode }

function buildTree(files: FileNode[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(files.map((f) => [f.id, { ...f, children: [] }]))
  const roots: TreeNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'FOLDER' ? -1 : 1))
    list.forEach((n) => sort(n.children))
  }
  sort(roots)
  return roots
}

export function FileTree({ files, activeFileId, dirtyIds, canEdit, onOpen, onCreate, onRename, onDelete }: Props) {
  const tree = useMemo(() => buildTree(files), [files])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)

  const folderForNew = selectedFolder && files.some((f) => f.id === selectedFolder) ? selectedFolder : null

  function startCreate(fileKind: FileKind) {
    setError(null)
    setDraft({ kind: 'create', parentId: folderForNew, fileKind })
    if (folderForNew) setCollapsed((c) => new Set([...c].filter((id) => id !== folderForNew)))
  }

  async function commit(name: string) {
    if (!draft) return
    const trimmed = name.trim()
    if (!trimmed || (draft.kind === 'rename' && trimmed === draft.file.name)) {
      setDraft(null)
      return
    }
    try {
      if (draft.kind === 'create') await onCreate(draft.parentId, trimmed, draft.fileKind)
      else await onRename(draft.file, trimmed)
      setDraft(null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work')
    }
  }

  async function remove(file: FileNode) {
    const what = file.kind === 'FOLDER' ? `the folder "${file.name}" and everything in it` : `"${file.name}"`
    if (!window.confirm(`Delete ${what}?`)) return
    try {
      await onDelete(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete')
    }
  }

  function toggle(folder: TreeNode) {
    setSelectedFolder(folder.id)
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(folder.id)) next.delete(folder.id)
      else next.add(folder.id)
      return next
    })
  }

  const renderDraftInput = (parentId: string | null, depth: number) =>
    draft?.kind === 'create' && draft.parentId === parentId ? (
      <NameInput depth={depth} icon={draft.fileKind === 'FOLDER' ? '▸' : '·'} initial="" onDone={commit} />
    ) : null

  function renderNodes(nodes: TreeNode[], depth: number) {
    return nodes.map((node) => {
      if (draft?.kind === 'rename' && draft.file.id === node.id) {
        return <NameInput key={node.id} depth={depth} icon={node.kind === 'FOLDER' ? '▸' : '·'} initial={node.name} onDone={commit} />
      }
      const isFolder = node.kind === 'FOLDER'
      const open = isFolder && !collapsed.has(node.id)
      return (
        <li key={node.id}>
          <div
            className={`tree-row${node.id === activeFileId ? ' active' : ''}${node.id === selectedFolder ? ' selected' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (isFolder ? toggle(node) : onOpen(node))}
            onDoubleClick={() => canEdit && setDraft({ kind: 'rename', file: node })}
            title={node.path}
          >
            <span className="tree-icon">{isFolder ? (open ? '▾' : '▸') : '·'}</span>
            <span className="tree-name">{node.name}</span>
            {dirtyIds.has(node.id) && <span className="dirty-dot" aria-label="unsaved changes" />}
            {canEdit && (
              <span className="tree-actions">
                <button type="button" className="icon" title="Rename" onClick={(e) => { e.stopPropagation(); setDraft({ kind: 'rename', file: node }) }}>✎</button>
                <button type="button" className="icon" title="Delete" onClick={(e) => { e.stopPropagation(); void remove(node) }}>×</button>
              </span>
            )}
          </div>
          {open && (
            <ul>
              {renderDraftInput(node.id, depth + 1)}
              {renderNodes(node.children, depth + 1)}
            </ul>
          )}
        </li>
      )
    })
  }

  return (
    <nav className="file-tree" aria-label="Files">
      <div className="tree-header">
        <span>Files</span>
        {canEdit && (
          <span>
            <button type="button" className="icon" title="New file" onClick={() => startCreate('FILE')}>+</button>
            <button type="button" className="icon" title="New folder" onClick={() => startCreate('FOLDER')}>▸+</button>
          </span>
        )}
      </div>
      {error && <p className="error small tree-error" role="alert">{error}</p>}
      <ul onClick={(e) => e.target === e.currentTarget && setSelectedFolder(null)}>
        {renderDraftInput(null, 0)}
        {renderNodes(tree, 0)}
      </ul>
      {files.length === 0 && !draft && <p className="muted small tree-empty">No files yet.</p>}
    </nav>
  )
}

function NameInput({ depth, icon, initial, onDone }: { depth: number; icon: string; initial: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial)
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onDone(initial)
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    onDone(value)
  }
  return (
    <li>
      <form className="tree-row editing" style={{ paddingLeft: 8 + depth * 14 }} onSubmit={submit}>
        <span className="tree-icon">{icon}</span>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} onBlur={() => onDone(value)} aria-label="Name" />
      </form>
    </li>
  )
}
