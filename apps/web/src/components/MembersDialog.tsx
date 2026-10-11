import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type Role, type Roster, type Workspace } from '../api.ts'

const ROLES: Role[] = ['OWNER', 'EDITOR', 'COMMENTER', 'VIEWER']
const ROLE_HELP: Record<Role, string> = {
  OWNER: 'Manage members and settings',
  EDITOR: 'Edit files',
  COMMENTER: 'Read and chat',
  VIEWER: 'Read only',
}

type Props = {
  workspace: Workspace
  currentUserId: string
  onClose: () => void
  onLeft: () => void
}

/** Members, roles and invitations (FR-03). Only owners can change anything; everyone can leave. */
export function MembersDialog({ workspace, currentUserId, onClose, onLeft }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [roster, setRoster] = useState<Roster | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('EDITOR')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const isOwner = workspace.role === 'OWNER'

  const load = useCallback(() => {
    api.members(workspace.id).then(setRoster).catch((e: Error) => setError(e.message))
  }, [workspace.id])

  useEffect(() => {
    dialog.current?.showModal()
    load()
  }, [load])

  async function run(action: () => Promise<unknown>, success?: string) {
    setError(null)
    setNotice(null)
    try {
      await action()
      if (success) setNotice(success)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work')
    }
  }

  async function invite(event: FormEvent) {
    event.preventDefault()
    await run(async () => {
      const result = await api.addMember(workspace.id, email, role)
      setNotice(result.member ? `${result.member.displayName} was added.` : `${email} was invited and joins when they sign up.`)
      setEmail('')
    })
  }

  async function leave() {
    if (!window.confirm(`Leave "${workspace.name}"? You will need a new invitation to come back.`)) return
    try {
      await api.removeMember(workspace.id, currentUserId)
      onLeft()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not leave')
    }
  }

  function remove(userId: string, name: string) {
    if (window.confirm(`Remove ${name} from this workspace?`)) {
      void run(() => api.removeMember(workspace.id, userId), `${name} was removed.`)
    }
  }

  return (
    <dialog ref={dialog} className="dialog card" onClose={onClose} aria-labelledby="members-title">
      <header className="dialog-header">
        <h2 id="members-title">Members</h2>
        <button type="button" className="icon" aria-label="Close" onClick={() => dialog.current?.close()}>×</button>
      </header>
      {error && <p className="error small" role="alert">{error}</p>}
      {notice && <p className="small notice" role="status">{notice}</p>}

      {isOwner && (
        <form className="invite-form" onSubmit={invite}>
          <input type="email" required placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email to invite" />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role for the invitation">
            {ROLES.map((r) => (
              <option key={r} value={r}>{r.toLowerCase()}</option>
            ))}
          </select>
          <button type="submit" className="primary">Invite</button>
        </form>
      )}

      <ul className="member-list">
        {roster?.members.map((m) => (
          <li key={m.userId}>
            <span>
              <strong>{m.displayName}</strong>
              {m.userId === currentUserId && <span className="muted small"> (you)</span>}
              <br />
              <span className="muted small">{m.email}</span>
            </span>
            {isOwner ? (
              <span className="member-actions">
                <select
                  value={m.role}
                  aria-label={`Role for ${m.displayName}`}
                  onChange={(e) => {
                    const next = e.target.value as Role
                    void run(() => api.changeRole(workspace.id, m.userId, next), `${m.displayName} is now ${next.toLowerCase()}.`)
                  }}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r} title={ROLE_HELP[r]}>{r.toLowerCase()}</option>
                  ))}
                </select>
                {m.userId !== currentUserId && (
                  <button type="button" className="ghost" onClick={() => remove(m.userId, m.displayName)}>Remove</button>
                )}
              </span>
            ) : (
              <span className="role-badge">{m.role.toLowerCase()}</span>
            )}
          </li>
        ))}
        {roster?.invitations.map((i) => (
          <li key={i.id}>
            <span>
              <strong>{i.email}</strong>
              <br />
              <span className="muted small">invited as {i.role.toLowerCase()}</span>
            </span>
            <button type="button" className="ghost" onClick={() => void run(() => api.cancelInvitation(workspace.id, i.id), 'Invitation cancelled.')}>
              Cancel
            </button>
          </li>
        ))}
      </ul>

      <footer className="dialog-footer">
        <button type="button" className="ghost" onClick={leave}>Leave workspace</button>
      </footer>
    </dialog>
  )
}
