import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAuth } from '../auth.tsx'

export function TopBar({ children }: { children?: ReactNode }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  async function signOut() {
    await logout()
    navigate('/login')
  }

  return (
    <header className="topbar">
      <Link to="/" className="brand">Converge</Link>
      <div className="topbar-middle">{children}</div>
      {user && (
        <div className="topbar-user">
          <span className="muted small">{user.displayName}</span>
          <button type="button" className="ghost" onClick={signOut}>Sign out</button>
        </div>
      )}
    </header>
  )
}
