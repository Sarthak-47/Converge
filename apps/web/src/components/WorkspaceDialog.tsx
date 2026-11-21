import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type Workspace } from '../api.ts'
import { Icon } from './Icon.tsx'

type Props = {
  workspace: Workspace
  onChanged: (workspace: Workspace) => void
  onClose: () => void
}

/** Workspace settings for owners: rename, archive and unarchive (FR-02). An archived workspace is read-only. */
export function WorkspaceDialog({ workspace, onChanged, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(workspace.name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const archived = workspace.status === 'ARCHIVED'

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  async function run(change: { name?: string; status?: Workspace['status'] }) {
    setBusy(true)
    setError(null)
    try {
      onChanged(await api.updateWorkspace(workspace.id, change))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the workspace')
    } finally {
      setBusy(false)
    }
  }

  function rename(event: FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed && trimmed !== workspace.name) void run({ name: trimmed })
  }

  return (
    <dialog ref={dialog} className="dialog card" onClose={onClose} aria-labelledby="workspace-title">
      <header className="dialog-header">
        <h2 id="workspace-title">Workspace settings</h2>
        <button type="button" className="icon" aria-label="Close" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </header>
      <form className="invite-form" onSubmit={rename}>
        <input aria-label="Workspace name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={busy || !name.trim() || name.trim() === workspace.name}>Rename</button>
      </form>
      <section className="settings-row">
        <div>
          <p className="settings-title">{archived ? 'This workspace is archived' : 'Archive this workspace'}</p>
          <p className="muted small">
            {archived
              ? 'Everyone can still read its files, history and chat. Unarchive it to edit again.'
              : 'It becomes read-only for everyone, open editors included. Nothing is deleted, and you can unarchive it any time.'}
          </p>
        </div>
        <button type="button" disabled={busy} onClick={() => void run({ status: archived ? 'ACTIVE' : 'ARCHIVED' })}>
          {archived ? 'Unarchive' : 'Archive'}
        </button>
      </section>
      {error && <p className="error small" role="alert">{error}</p>}
    </dialog>
  )
}
