import { useEffect, useRef, useState } from 'react'
import { api, type DeletedFile } from '../api.ts'
import { errorMessage } from './agentKit.ts'
import { Icon } from './Icon.tsx'

type Props = { workspaceId: string; onClose: () => void }

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Files deleted in the last 30 days, by hand or by an import, brought back at their old path with their
 * text and versions. Deleting only marks a file, so nothing here is ever lost before then.
 */
export function DeletedFilesDialog({ workspaceId, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [files, setFiles] = useState<DeletedFile[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialog.current?.showModal()
    api.deletedFiles(workspaceId).then(setFiles).catch((e) => {
      setFiles([])
      setError(errorMessage(e, 'Could not load deleted files'))
    })
  }, [workspaceId])

  async function restore(file: DeletedFile) {
    setBusy(file.id)
    setError(null)
    try {
      await api.undeleteFile(file.id)
      setFiles((list) => list?.filter((f) => f.id !== file.id) ?? null)
    } catch (e) {
      setError(errorMessage(e, `Could not restore ${file.path}`))
    } finally {
      setBusy(null)
    }
  }

  return (
    <dialog ref={dialog} className="dialog card" onClose={onClose} aria-labelledby="deleted-title">
      <header className="dialog-header">
        <h2 id="deleted-title">Recently deleted</h2>
        <button type="button" className="icon" aria-label="Close" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </header>
      <p className="muted small">Files deleted in the last 30 days. Restoring puts one back where it was, with its history.</p>
      {files === null && <p className="muted small">Loading…</p>}
      {files?.length === 0 && !error && <p className="muted small">Nothing has been deleted lately.</p>}
      {files && files.length > 0 && (
        <ol className="deleted-list" aria-label="Deleted files">
          {files.map((file) => (
            <li key={file.id}>
              <span className="deleted-path">
                <code>{file.path}</code>
                <time className="muted small" dateTime={file.deletedAt}>{when.format(new Date(file.deletedAt))}</time>
              </span>
              <button type="button" disabled={busy !== null} aria-label={`Restore ${file.path}`} onClick={() => void restore(file)}>
                {busy === file.id ? 'Restoring…' : 'Restore'}
              </button>
            </li>
          ))}
        </ol>
      )}
      {error && <p className="error small" role="alert">{error}</p>}
    </dialog>
  )
}
