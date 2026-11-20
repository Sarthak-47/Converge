import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, type Workspace } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { TopBar } from '../components/TopBar.tsx'

function monogram(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? words[0][0] + words[1][0] : name.trim().slice(0, 2)).toUpperCase()
}

export function WorkspacesPage() {
  const navigate = useNavigate()
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.workspaces().then(setWorkspaces).catch((e: Error) => setError(e.message))
  }, [])

  async function create(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      const workspace = await api.createWorkspace(name)
      navigate(`/w/${workspace.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the workspace')
    }
  }

  return (
    <div className="page">
      <TopBar />
      <main className="content">
        <div className="page-head">
          <h1>Workspaces</h1>
          <form className="create-form" onSubmit={create}>
            <input placeholder="New workspace name" aria-label="New workspace name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="primary">
              <Icon name="plus" size={15} />
              Create
            </button>
          </form>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {workspaces === null ? (
          <ul className="workspace-list" aria-busy="true" aria-label="Loading workspaces">
            {[0, 1, 2].map((i) => (
              <li key={i} className="skeleton-row" aria-hidden="true">
                <span className="skeleton" />
              </li>
            ))}
          </ul>
        ) : workspaces.length === 0 ? (
          <p className="empty-line">No workspaces yet. Name one above to start.</p>
        ) : (
          <ul className="workspace-list">
            {workspaces.map((w) => (
              <li key={w.id} data-archived={w.status === 'ARCHIVED' || undefined}>
                <Link to={`/w/${w.id}`} className="workspace-link">
                  <span className="monogram" aria-hidden="true">{monogram(w.name)}</span>
                  <span className="workspace-title">{w.name}</span>
                </Link>
                <span className="workspace-meta">
                  {w.role.toLowerCase()}
                  {w.status === 'ARCHIVED' && ' · archived'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
