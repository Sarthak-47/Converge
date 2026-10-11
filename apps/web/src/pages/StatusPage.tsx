import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { fetchHealth, type ServiceRow } from '../health.ts'

const POLL_MS = 5000

export function StatusPage() {
  const [rows, setRows] = useState<ServiceRow[] | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const load = () => fetchHealth(controller.signal).then(setRows).catch(() => undefined)
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [])

  return (
    <main className="status-page">
      <header>
        <h1>Converge</h1>
        <p>Stack health · <Link to="/">Back to workspaces</Link></p>
      </header>
      {rows === null ? (
        <p className="muted">Checking services…</p>
      ) : (
        <ul className="services">
          {rows.map((row) => (
            <li key={row.name}>
              <span>{row.name}</span>
              <span className={`badge ${row.status === 'UP' ? 'up' : 'down'}`}>{row.status}</span>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}

