import { useEffect, useState } from 'react'
import { fetchHealth, type ServiceRow } from './health.ts'
import './App.css'

const POLL_MS = 5000

function App() {
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
    <main className="shell">
      <header>
        <h1>Converge</h1>
        <p>Phase 0 · stack health</p>
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

export default App
