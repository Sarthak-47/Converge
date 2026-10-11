import { useEffect, useState } from 'react'
import { desktop, type SyncEvent } from '../desktop.ts'

function describe(event: SyncEvent): string {
  switch (event.type) {
    case 'written':
      return `Updated ${event.path} on disk`
    case 'sent':
      return `Sent your change to ${event.path}`
    case 'created':
      return `Added ${event.path} to the workspace`
    case 'deleted':
      return `Deleted ${event.path} from the workspace`
    case 'trashed':
      return `Moved ${event.path} to .converge/trash`
    case 'skipped':
      return `Not syncing ${event.path}: ${event.reason}`
    case 'refused':
      return `Refused unsafe path ${event.path}`
    case 'error':
      return `Problem with ${event.path}: ${event.message}`
  }
}

/** Desktop only: mirrors the workspace into a local folder (design §12). Renders nothing in a browser. */
export function SyncControl({ workspaceId }: { workspaceId: string }) {
  const [folder, setFolder] = useState<string | null>(null)
  const [last, setLast] = useState<SyncEvent | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void desktop.status().then((s) => {
      if (!cancelled) setFolder(s?.workspaceId === workspaceId ? s.folder : null)
    })
    const stop = desktop.onSyncEvent(setLast)
    return () => {
      cancelled = true
      stop()
    }
  }, [workspaceId])

  if (!desktop) return null
  const api = desktop

  async function start() {
    setError(null)
    try {
      const chosen = await api.chooseFolder()
      if (!chosen) return
      const { started } = await api.startSync(workspaceId, chosen)
      if (started) setFolder(chosen)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start syncing')
    }
  }

  async function stop() {
    await api.stopSync()
    setFolder(null)
    setLast(null)
  }

  if (!folder) {
    return (
      <span className="sync-control">
        <button type="button" className="ghost" onClick={() => void start()}>Sync to folder…</button>
        {error && <span className="error small">{error}</span>}
      </span>
    )
  }
  return (
    <span className="sync-control" title={last ? describe(last) : 'Watching for changes'}>
      <span className={`connection ${last?.type === 'error' ? '' : 'connected'}`}>Syncing to {folder}</span>
      <button type="button" className="ghost" onClick={() => void stop()}>Stop</button>
    </span>
  )
}
