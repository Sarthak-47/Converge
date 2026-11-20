import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type GitRepository, type Workspace } from '../api.ts'
import { errorMessage } from './agentKit.ts'

type Props = { workspace: Workspace; onClose: () => void }

/**
 * Connects the workspace to a GitHub repository (design §10). Owners add a token that can push branches and
 * open pull requests; it is stored encrypted and only a hint is ever shown. Desktop members can also commit
 * and push from their own checkout with their own credentials.
 */
export function GitDialog({ workspace, onClose }: Props) {
  const [repository, setRepository] = useState<GitRepository | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const isOwner = workspace.role === 'OWNER'
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    dialog.current?.showModal()
    api.gitRepository(workspace.id)
      .then((r) => setRepository(r ?? null))
      .catch(() => setRepository(null))
      .finally(() => setLoaded(true))
  }, [workspace.id])

  async function act(action: () => Promise<void>, fallback: string) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e, fallback))
    } finally {
      setBusy(false)
    }
  }

  function connect(event: FormEvent) {
    event.preventDefault()
    void act(async () => {
      setRepository(await api.connectGit(workspace.id, { remoteUrl: remoteUrl.trim(), defaultBranch: defaultBranch.trim(), token: token.trim() }))
      setToken('')
    }, 'Could not connect the repository')
  }

  return (
    <dialog ref={dialog} className="dialog card" onClose={onClose} aria-labelledby="git-title">
      <header className="dialog-header">
        <h2 id="git-title">Repository</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close">✕</button>
      </header>
        {!loaded && <p className="muted small">Loading…</p>}
        {loaded && repository && (
          <div className="git-connected">
            <p>Connected to <strong>{repository.owner}/{repository.repo}</strong> (default branch <code>{repository.defaultBranch}</code>).</p>
            <p className="muted small">Token {repository.credentialHint}, added by {repository.connectedByName}. Sessions open pull requests here.</p>
            {isOwner && (
              <button type="button" className="ghost" disabled={busy} onClick={() => void act(async () => {
                await api.disconnectGit(workspace.id)
                setRepository(null)
              }, 'Could not disconnect')}>Disconnect</button>
            )}
          </div>
        )}
        {loaded && !repository && !isOwner && <p className="muted small">No repository is connected. An owner can connect one.</p>}
        {loaded && !repository && isOwner && (
          <form className="git-form" onSubmit={connect}>
            <label htmlFor="git-remote">Repository URL</label>
            <input id="git-remote" placeholder="https://github.com/owner/repo.git" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} />
            <label htmlFor="git-branch">Default branch</label>
            <input id="git-branch" value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} />
            <label htmlFor="git-token">Access token</label>
            <input id="git-token" type="password" autoComplete="off" placeholder="A token that can push branches and open pull requests" value={token} onChange={(e) => setToken(e.target.value)} />
            <p className="muted small">Stored encrypted and never shown again. Converge pushes branches named converge/… and never deletes files from the repository.</p>
            <button type="submit" className="primary" disabled={busy || !remoteUrl.trim() || !token.trim()}>Connect</button>
          </form>
        )}
        {error && <p className="error small" role="alert">{error}</p>}
    </dialog>
  )
}
