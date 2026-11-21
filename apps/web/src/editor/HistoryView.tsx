import { useEffect, useRef, useState } from 'react'
import { api, type Version } from '../api.ts'
import { editorFont, monaco, monacoTheme } from './monaco.ts'
import { Icon } from '../components/Icon.tsx'

type Props = {
  fileId: string
  /** The live model: the right-hand side keeps updating as people type. */
  current: monaco.editor.ITextModel
  canRestore: boolean
  onClose: () => void
  onRestored: (version: number) => void
}

const REASON: Record<Version['reason'], string> = {
  MANUAL: 'Checkpoint',
  AUTO: 'Autosave',
  PRE_EXTERNAL: 'Before a change',
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Version list plus a diff of the chosen version against the live text, or against any other version (FR-10, FR-11). */
export default function HistoryView({ fileId, current, canRestore, onClose, onRestored }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [selected, setSelected] = useState<Version | null>(null)
  /** The right-hand side: the live text, or another version's id. */
  const [compareWith, setCompareWith] = useState<'current' | string>('current')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const host = useRef<HTMLDivElement>(null)
  const diff = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const original = useRef<monaco.editor.ITextModel | null>(null)
  const other = useRef<monaco.editor.ITextModel | null>(null)

  useEffect(() => {
    api.history(fileId)
      .then((list) => {
        setVersions(list)
        setSelected(list[0] ?? null)
      })
      .catch((e: Error) => setError(e.message))
  }, [fileId])

  useEffect(() => {
    diff.current = monaco.editor.createDiffEditor(host.current!, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      minimap: { enabled: false },
      theme: monacoTheme(),
      ...editorFont,
    })
    return () => {
      diff.current?.dispose()
      original.current?.dispose()
      other.current?.dispose()
    }
  }, [])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    const against = compareWith === 'current' ? null : compareWith
    Promise.all([api.snapshotText(fileId, selected.id), against ? api.snapshotText(fileId, against) : Promise.resolve(null)])
      .then(([left, right]) => {
        if (cancelled || !diff.current) return
        const previous = [original.current, other.current]
        original.current = monaco.editor.createModel(left.text, current.getLanguageId())
        other.current = right ? monaco.editor.createModel(right.text, current.getLanguageId()) : null
        diff.current.setModel({ original: original.current, modified: other.current ?? current })
        previous.forEach((m) => m?.dispose())
      })
      .catch((e: Error) => setError(e.message))
    return () => {
      cancelled = true
    }
  }, [fileId, selected, compareWith, current])

  const compared = compareWith === 'current' ? null : versions?.find((v) => v.id === compareWith) ?? null

  async function restore() {
    if (!selected) return
    if (!window.confirm(`Restore version ${selected.versionNo}? The current text is kept as a new version first, so this can be undone.`)) return
    setBusy(true)
    try {
      await api.restore(fileId, selected.id)
      onRestored(selected.versionNo)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="history">
      <aside className="history-list" aria-label="Versions">
        <div className="tree-header">
          <span>History</span>
          <button type="button" className="icon" aria-label="Close history" onClick={onClose}><Icon name="close" /></button>
        </div>
        {error && <p className="error small tree-error" role="alert">{error}</p>}
        {versions?.length === 0 && <p className="muted small tree-empty">No versions yet. Create a checkpoint to start one.</p>}
        <ol>
          {versions?.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                className={`version${v.id === selected?.id ? ' active' : ''}`}
                onClick={() => {
                  setSelected(v)
                  if (v.id === compareWith) setCompareWith('current')
                }}
                aria-pressed={v.id === selected?.id}
              >
                <strong>v{v.versionNo}</strong> {v.label ?? REASON[v.reason]}
                <span className="muted small">
                  {when.format(new Date(v.createdAt))}
                  {v.createdByName ? ` · ${v.createdByName}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </aside>
      <section className="history-diff">
        <div className="editor-peers">
          {selected ? (
            <label className="compare-with">
              <span>Version {selected.versionNo} (left) compared with</span>
              <select value={compareWith} onChange={(e) => setCompareWith(e.target.value)} aria-label="Compare with">
                <option value="current">the current text</option>
                {versions?.filter((v) => v.id !== selected.id).map((v) => (
                  <option key={v.id} value={v.id}>version {v.versionNo}{v.label ? ` (${v.label})` : ''}</option>
                ))}
              </select>
              <span>(right)</span>
            </label>
          ) : (
            <span>Select a version</span>
          )}
          {compared && <span className="muted small">Both sides are saved versions; the live text is not shown.</span>}
          {canRestore && selected && (
            <button type="button" className="primary" disabled={busy} onClick={() => void restore()}>
              Restore this version
            </button>
          )}
        </div>
        <div className="code-editor" ref={host} />
      </section>
    </div>
  )
}
