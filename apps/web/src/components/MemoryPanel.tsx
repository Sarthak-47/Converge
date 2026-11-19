import { useCallback, useEffect, useState } from 'react'
import { api, type Memory, type RangeLock, type Role } from '../api.ts'
import { errorMessage } from './agentKit.ts'

type Props = {
  workspaceId: string
  currentUserId: string
  role: Role
  refreshSignal: number
  onShow: (fileId: string) => void
}

/**
 * Workspace memory and held ranges (design §13.10, §13.11): what people and agents pinned to code, which notes
 * went stale because their code changed, and who is holding which range.
 */
export function MemoryPanel({ workspaceId, currentUserId, role, refreshSignal, onShow }: Props) {
  const [notes, setNotes] = useState<Memory[]>([])
  const [locks, setLocks] = useState<RangeLock[]>([])
  const [error, setError] = useState<string | null>(null)
  const canWrite = role !== 'VIEWER'

  const reload = useCallback(() => {
    api.memories(workspaceId).then(setNotes).catch(() => undefined)
    api.locks(workspaceId).then(setLocks).catch(() => undefined)
  }, [workspaceId])

  useEffect(() => {
    reload()
  }, [reload, refreshSignal])

  async function act(action: () => Promise<unknown>, fallback: string) {
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e, fallback))
    } finally {
      reload()
    }
  }

  const stale = notes.filter((n) => n.status === 'STALE')
  return (
    <section className="agents memory-panel" aria-label="Memory">
      <div className="session-scroll">
        {stale.length > 0 && (
          <p className="overlap-warning small" role="status">
            {stale.length} note{stale.length === 1 ? '' : 's'} no longer match{stale.length === 1 ? 'es' : ''} their code. Rewrite or retire {stale.length === 1 ? 'it' : 'them'}.
          </p>
        )}
        <h3 className="session-section">Held ranges</h3>
        <ul className="memory-list">
          {locks.length === 0 && <li className="muted small">Nobody is holding code. Select code and press Hold to keep agents out of it for a while.</li>}
          {locks.map((lock) => (
            <li key={lock.id} className="memory-item">
              <p className="small"><strong>{lock.holderName}</strong> holds <button type="button" className="link small" onClick={() => onShow(lock.fileId)}>{lock.path}</button> until {new Date(lock.expiresAt).toLocaleTimeString()}</p>
              <p className="small">{lock.reason}</p>
              <pre className="comment-quote">{lock.quote}</pre>
              {(lock.holderId === currentUserId || role === 'OWNER') && (
                <button type="button" className="link small" onClick={() => void act(() => api.releaseLock(lock.id), 'Could not release')}>Release</button>
              )}
            </li>
          ))}
        </ul>
        <h3 className="session-section">Notes</h3>
        <ul className="memory-list">
          {notes.length === 0 && <li className="muted small">No notes yet. Select code and press Note to pin a decision, gotcha or convention to it.</li>}
          {notes.map((note) => (
            <li key={note.id} className={`memory-item ${note.status === 'STALE' ? 'stale' : ''}`} aria-label={`Note on ${note.path}: ${note.body}`}>
              <p className="small">
                <span className={`memory-kind kind-${note.kind.toLowerCase()}`}>{note.kind.toLowerCase()}</span>{' '}
                <button type="button" className="link small" onClick={() => onShow(note.fileId)}>{note.path}</button>
                {note.status === 'STALE' && <span className="memory-stale"> stale</span>}
                <span className="muted"> · {note.createdInTurn ? `${note.authorName}'s agent` : note.authorName}</span>
              </p>
              <p>{note.body}</p>
              <pre className="comment-quote">{note.anchoredText}</pre>
              {note.status === 'STALE' && (
                <p className="muted small">Now: {note.currentText === null ? 'the code was deleted' : <code>{note.currentText.slice(0, 200)}</code>}</p>
              )}
              {canWrite && (
                <div className="comment-actions">
                  <button type="button" className="link small" onClick={() => {
                    const body = window.prompt('Rewrite the note', note.body)?.trim()
                    if (body) void act(() => api.updateMemory(note, body), 'Could not update the note')
                  }}>Edit</button>
                  <button type="button" className="link small" onClick={() => void act(() => api.retireMemory(note), 'Could not retire the note')}>Retire</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      {error && <p className="error small agent-panel-error" role="alert">{error}</p>}
    </section>
  )
}
