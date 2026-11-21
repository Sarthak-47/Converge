import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type GitOperation, type GitRepository, type Workspace } from '../api.ts'
import { errorMessage } from './agentKit.ts'
import { Icon } from './Icon.tsx'

type Props = { workspace: Workspace; onClose: () => void; refreshSignal?: number }

function describe(op: GitOperation): string {
  const what = op.type === 'PULL' ? 'Import' : op.type === 'PULL_REQUEST' ? 'Pull request' : 'Push'
  if (op.status === 'FAILED') return `${what} failed: ${op.error ?? 'unknown error'}`
  if (op.status !== 'SUCCEEDED' || !op.result) return `${what} ${op.status === 'QUEUED' ? 'queued' : 'running'}…`
  if (op.type === 'PULL') {
    const r = op.result
    return `Imported ${op.params.branch}: ${r.created ?? 0} new, ${r.updated ?? 0} updated, ${r.unchanged ?? 0} unchanged${r.skipped?.length ? `, ${r.skipped.length} skipped` : ''}`
  }
  return `${what} on ${op.result.branch} (${op.result.changedFiles} file${op.result.changedFiles === 1 ? '' : 's'})`
}

/**
 * Connects the workspace to a GitHub repository (design §10). Owners add a token that can push branches and
 * open pull requests; it is stored encrypted and only a hint is ever shown. Desktop members can also commit
 * and push from their own checkout with their own credentials.
 */
export function GitDialog({ workspace, onClose, refreshSignal = 0 }: Props) {
  const [repository, setRepository] = useState<GitRepository | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const isOwner = workspace.role === 'OWNER'
  const canEdit = isOwner || workspace.role === 'EDITOR'
  const [operations, setOperations] = useState<GitOperation[]>([])
  /** Shown once, right after automatic import is turned on. */
  const [newHook, setNewHook] = useState<{ url: string; secret: string } | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    dialog.current?.showModal()
    api.gitRepository(workspace.id)
      .then((r) => setRepository(r ?? null))
      .catch(() => setRepository(null))
      .finally(() => setLoaded(true))
  }, [workspace.id])

  useEffect(() => {
    if (repository) api.gitOperations(workspace.id).then(setOperations).catch(() => setOperations([]))
  }, [workspace.id, repository, refreshSignal])

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
        <button type="button" className="ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </header>
        {!loaded && <p className="muted small">Loading…</p>}
        {loaded && repository && (
          <div className="git-connected">
            <p>Connected to <strong>{repository.owner}/{repository.repo}</strong> (default branch <code>{repository.defaultBranch}</code>).</p>
            <p className="muted small">Token {repository.credentialHint}, added by {repository.connectedByName}. Sessions open pull requests here.</p>
            {canEdit && (
              <button type="button" className="ghost" disabled={busy} onClick={() => void act(async () => {
                const op = await api.importRepository(workspace.id, crypto.randomUUID())
                setOperations((list) => [op, ...list])
              }, 'Could not start the import')}>Import files from {repository.defaultBranch}</button>
            )}
            <p className="muted small">Importing creates the branch's text files here and merges changes into existing ones; nothing is deleted.</p>
            {operations.length > 0 && (
              <ul className="git-operations" aria-label="Recent Git operations">
                {operations.slice(0, 8).map((op) => (
                  <li key={op.id} data-status={op.status}>
                    {op.result?.prUrl ? <a href={op.result.prUrl} target="_blank" rel="noreferrer noopener">{describe(op)}</a> : describe(op)}
                  </li>
                ))}
              </ul>
            )}
            {isOwner && (
              <section className="settings-row" aria-label="Automatic import">
                <div>
                  <p className="settings-title">Automatic import {repository.webhook ? 'is on' : 'is off'}</p>
                  <p className="muted small">
                    {repository.webhook
                      ? `Every push to ${repository.defaultBranch} on GitHub is imported here, merged into open files like any import.`
                      : `Import every push to ${repository.defaultBranch} on GitHub automatically, through a GitHub webhook.`}
                  </p>
                </div>
                <button type="button" disabled={busy} onClick={() => void act(async () => {
                  if (repository.webhook) {
                    await api.disableGitWebhook(workspace.id)
                    setNewHook(null)
                    setRepository({ ...repository, webhook: false })
                  } else {
                    const hook = await api.enableGitWebhook(workspace.id)
                    setNewHook({ url: new URL(hook.path, window.location.origin).href, secret: hook.secret })
                    setRepository({ ...repository, webhook: true })
                  }
                }, 'Could not change automatic import')}>{repository.webhook ? 'Turn off' : 'Turn on'}</button>
              </section>
            )}
            {newHook && (
              <div className="webhook-setup" role="status">
                <p className="small">
                  On GitHub, open the repository's Settings → Webhooks → Add webhook, and enter these. The secret is shown only now;
                  turning automatic import on again makes a new one.
                </p>
                <label className="small" htmlFor="webhook-url">Payload URL</label>
                <input id="webhook-url" readOnly value={newHook.url} onFocus={(e) => e.currentTarget.select()} />
                <label className="small" htmlFor="webhook-secret">Secret</label>
                <input id="webhook-secret" readOnly value={newHook.secret} onFocus={(e) => e.currentTarget.select()} />
                <p className="muted small">Content type: application/json. Events: just the push event.</p>
              </div>
            )}
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
