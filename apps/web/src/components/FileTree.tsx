import { useMemo, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react'
import type { FileKind, FileNode } from '../api.ts'
import { askText } from './askText.tsx'
import { Icon, type IconName } from './Icon.tsx'

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
  /** Moves a file or folder into a folder, or to the top level when the parent is null (FR-04). */
  onMove: (file: FileNode, parentId: string | null) => Promise<void>
}

/** The drag payload: a file's id, under a type of our own so other drags (text, files from the desktop) are ignored. */
const DRAG_TYPE = 'application/x-converge-file'

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

export function FileTree({ files, activeFileId, dirtyIds, canEdit, onOpen, onCreate, onRename, onDelete, onMove }: Props) {
  const tree = useMemo(() => buildTree(files), [files])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const ROOT = '<root>'

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

  /** Whether `file` may go into `parentId` (null: top level): not where it already is, and never into itself. */
  function canMoveTo(file: FileNode, parentId: string | null) {
    if (file.parentId === parentId) return false
    if (parentId === null) return true
    const parent = files.find((f) => f.id === parentId)
    return !!parent && parent.id !== file.id && !parent.path.startsWith(file.path + '/')
  }

  async function move(file: FileNode, parentId: string | null) {
    if (!canMoveTo(file, parentId)) return
    try {
      await onMove(file, parentId)
      if (parentId) setCollapsed((c) => new Set([...c].filter((id) => id !== parentId)))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move')
    }
  }

  /** The keyboard way to move: name the destination folder by its path. */
  async function moveByPath(file: FileNode) {
    const answer = await askText({
      title: `Move ${file.name}`,
      label: 'Destination folder (its path, e.g. src/utils; leave empty for the top level)',
      initial: files.find((f) => f.id === file.parentId)?.path ?? '',
      submitLabel: 'Move',
      optional: true,
    })
    if (answer === null) return
    const path = answer.trim().replace(/^\/+|\/+$/g, '')
    if (!path) return move(file, null)
    const folder = files.find((f) => f.kind === 'FOLDER' && f.path === path)
    if (!folder) {
      setError(`There is no folder "${path}"`)
      return
    }
    return move(file, folder.id)
  }

  function draggedFile(event: DragEvent) {
    const id = event.dataTransfer.getData(DRAG_TYPE)
    return files.find((f) => f.id === id)
  }

  /** Drop-zone handlers for a folder (or the top level when `parentId` is null). */
  function dropZone(parentId: string | null) {
    const key = parentId ?? ROOT
    return {
      onDragOver(event: DragEvent) {
        if (!canEdit || !event.dataTransfer.types.includes(DRAG_TYPE)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = 'move'
        setDropTarget(key)
      },
      onDragLeave(event: DragEvent) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget((t) => (t === key ? null : t))
      },
      onDrop(event: DragEvent) {
        event.preventDefault()
        event.stopPropagation()
        setDropTarget(null)
        const file = draggedFile(event)
        if (file) void move(file, parentId)
      },
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
      <NameInput depth={depth} icon={draft.fileKind === 'FOLDER' ? 'folder' : 'file'} initial="" onDone={commit} />
    ) : null

  function renderNodes(nodes: TreeNode[], depth: number) {
    return nodes.map((node) => {
      if (draft?.kind === 'rename' && draft.file.id === node.id) {
        return <NameInput key={node.id} depth={depth} icon={node.kind === 'FOLDER' ? 'folder' : 'file'} initial={node.name} onDone={commit} />
      }
      const isFolder = node.kind === 'FOLDER'
      const open = isFolder && !collapsed.has(node.id)
      return (
        <li key={node.id}>
          <div
            className={`tree-row${node.id === activeFileId ? ' active' : ''}${node.id === selectedFolder ? ' selected' : ''}${dropTarget === node.id ? ' drop-target' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            draggable={canEdit}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, node.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => setDropTarget(null)}
            {...(isFolder ? dropZone(node.id) : {})}
            onClick={() => (isFolder ? toggle(node) : onOpen(node))}
            onDoubleClick={() => canEdit && setDraft({ kind: 'rename', file: node })}
            title={node.path}
          >
            <span className={`tree-icon${open ? ' open' : ''}`}>{isFolder ? <Icon name="chevron" size={13} /> : <Icon name="file" size={14} />}</span>
            <span className="tree-name">{node.name}</span>
            {dirtyIds.has(node.id) && <span className="dirty-dot" aria-label="unsaved changes" />}
            {canEdit && (
              <span className="tree-actions">
                <button type="button" className="icon" title="Move" aria-label={`Move ${node.name}`} onClick={(e) => { e.stopPropagation(); void moveByPath(node) }}><Icon name="move" size={14} /></button>
                <button type="button" className="icon" title="Rename" aria-label={`Rename ${node.name}`} onClick={(e) => { e.stopPropagation(); setDraft({ kind: 'rename', file: node }) }}><Icon name="pencil" size={14} /></button>
                <button type="button" className="icon" title="Delete" aria-label={`Delete ${node.name}`} onClick={(e) => { e.stopPropagation(); void remove(node) }}><Icon name="close" size={14} /></button>
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
    <nav className={dropTarget === ROOT ? 'file-tree drop-target' : 'file-tree'} aria-label="Files" {...dropZone(null)}>
      <div className="tree-header">
        <span>Files</span>
        {canEdit && (
          <span>
            <button type="button" className="icon" title="New file" aria-label="New file" onClick={() => startCreate('FILE')}><Icon name="filePlus" size={15} /></button>
            <button type="button" className="icon" title="New folder" aria-label="New folder" onClick={() => startCreate('FOLDER')}><Icon name="folderPlus" size={15} /></button>
          </span>
        )}
      </div>
      {error && <p className="error small tree-error" role="alert">{error}</p>}
      <ul className="tree-root" onClick={(e) => e.target === e.currentTarget && setSelectedFolder(null)}>
        {renderDraftInput(null, 0)}
        {renderNodes(tree, 0)}
      </ul>
      {files.length === 0 && !draft && <p className="muted small tree-empty">No files yet.</p>}
    </nav>
  )
}

function NameInput({ depth, icon, initial, onDone }: { depth: number; icon: IconName; initial: string; onDone: (name: string) => void }) {
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
        <span className="tree-icon"><Icon name={icon} size={14} /></span>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} onBlur={() => onDone(value)} aria-label="Name" />
      </form>
    </li>
  )
}
