import { colorFor } from '../editor/collabDocument.ts'
import type { OnlineUser } from '../realtime/workspaceChannel.ts'

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase()
}

/** Who has this workspace open, in the same colours their cursors use. */
export function PresenceAvatars({ online }: { online: OnlineUser[] }) {
  if (online.length === 0) return null
  const names = online.map((u) => (u.connections > 1 ? `${u.displayName} (${u.connections} tabs)` : u.displayName))
  return (
    <span className="presence" aria-label={`Online: ${names.join(', ')}`} title={`Online: ${names.join(', ')}`}>
      {online.slice(0, 5).map((u) => (
        <span key={u.userId} className="avatar" style={{ background: colorFor(u.userId) }}>
          {initials(u.displayName)}
        </span>
      ))}
      {online.length > 5 && <span className="muted small">+{online.length - 5}</span>}
    </span>
  )
}
