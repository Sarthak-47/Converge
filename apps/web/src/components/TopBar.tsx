import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAuth } from '../auth.tsx'
import { colorFor, inkFor } from '../editor/collabDocument.ts'
import { DevicesDialog } from './DevicesDialog.tsx'
import { BrandMark } from './Icon.tsx'
import { ThemeSwitch } from './ThemeSwitch.tsx'
import { initials, stickerStyle } from './sticker.ts'

export function TopBar({ children }: { children?: ReactNode }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [showDevices, setShowDevices] = useState(false)

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
            <button type="button" className="me" title={`${user.displayName}: signed-in devices`} aria-label="Signed-in devices" onClick={() => setShowDevices(true)}>
              <span className="avatar avatar-sm" style={{ ...stickerStyle(user.id), background: colorFor(user.id), color: inkFor(colorFor(user.id)) }} aria-hidden="true">{initials(user.displayName)}</span>
              <span className="me-name">{user.displayName}</span>
            </button>
            <button type="button" className="ghost" onClick={signOut}>Sign out</button>
            {showDevices && <DevicesDialog onClose={() => setShowDevices(false)} />}
          </>
        )}
      </div>
    </header>
  )
}
