import { useEffect, useRef, useState } from 'react'
import { api, type SignedInSession } from '../api.ts'
import { errorMessage } from './agentKit.ts'
import { Icon } from './Icon.tsx'

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Where you are signed in, and signing other devices out (say, a borrowed laptop). */
export function DevicesDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [sessions, setSessions] = useState<SignedInSession[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialog.current?.showModal()
    api.signedInDevices().then(setSessions).catch((e) => {
      setSessions([])
      setError(errorMessage(e, 'Could not load your signed-in devices'))
    })
  }, [])

  async function act(action: () => Promise<void>, fallback: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
      setSessions(await api.signedInDevices())
    } catch (e) {
      setError(errorMessage(e, fallback))
    } finally {
      setBusy(false)
    }
  }

  const others = sessions?.filter((s) => !s.current) ?? []

  return (
    <dialog ref={dialog} className="dialog card" onClose={onClose} aria-labelledby="devices-title">
      <header className="dialog-header">
        <h2 id="devices-title">Signed-in devices</h2>
        <button type="button" className="icon" aria-label="Close" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
      </header>
      {sessions === null && <p className="muted small">Loading…</p>}
      {sessions && sessions.length > 0 && (
        <ol className="device-list" aria-label="Devices">
          {sessions.map((session) => (
            <li key={session.id}>
              <span className="device-what">
                <strong>{session.device}</strong>
                <span className="muted small">
                  {session.current ? 'This device' : `Last active ${when.format(new Date(session.lastActiveAt))}`}
                  {' · signed in '}{when.format(new Date(session.signedInAt))}
                </span>
              </span>
              {!session.current && (
                <button type="button" disabled={busy} aria-label={`Sign out ${session.device}`}
                  onClick={() => void act(() => api.endSession(session.id), 'Could not sign that device out')}>Sign out</button>
              )}
            </li>
          ))}
        </ol>
      )}
      {others.length > 1 && (
        <button type="button" className="device-all" disabled={busy}
          onClick={() => void act(async () => { await api.endOtherSessions() }, 'Could not sign the other devices out')}>
          Sign out everywhere else
        </button>
      )}
      {sessions && others.length === 0 && !error && <p className="muted small">You are signed in only here.</p>}
      {error && <p className="error small" role="alert">{error}</p>}
    </dialog>
  )
}
