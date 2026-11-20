import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAuth } from '../auth.tsx'
import { colorFor } from '../editor/collabDocument.ts'
import { BrandMark } from './Icon.tsx'
import { ThemeSwitch } from './ThemeSwitch.tsx'

export function TopBar({ children }: { children?: ReactNode }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  async function signOut() {
    await logout()
    navigate('/login')
  }

  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label="Converge, all workspaces">
        <BrandMark />
      </Link>
      <div className="topbar-middle">{children}</div>
      <div className="topbar-user">
        <ThemeSwitch />
        {user && (
          <>
            <span className="me" title={user.displayName}>
              <span className="me-dot" style={{ background: colorFor(user.id) }} aria-hidden="true" />
              <span className="me-name">{user.displayName}</span>
            </span>
            <button type="button" className="ghost" onClick={signOut}>Sign out</button>
          </>
        )}
      </div>
    </header>
  )
}
