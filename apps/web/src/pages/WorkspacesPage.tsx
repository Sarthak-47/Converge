import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { api, type Workspace } from '../api.ts'
import { TopBar } from '../components/TopBar.tsx'

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
        <h1>Workspaces</h1>
        <form className="inline-form" onSubmit={create}>
          <input placeholder="New workspace name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="primary">Create</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {workspaces === null ? (
          <p className="muted">Loading…</p>
        ) : workspaces.length === 0 ? (
          <p className="muted">No workspaces yet. Create one to start editing.</p>
        ) : (
          <ul className="list card">
            {workspaces.map((w) => (
              <li key={w.id}>
                <Link to={`/w/${w.id}`}>{w.name}</Link>
                <span className="muted small">
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
