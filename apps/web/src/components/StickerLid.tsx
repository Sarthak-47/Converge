import type { CSSProperties } from 'react'

// The sign-in lid: a workspace as a laptop lid with its people, their agents and its file stuck on it. Every sticker
// is something the product shows inside (a person, their agent, the shared file, Live, a named approval). The names
// are illustrative, not real users.
type Sticker = { label: string; kind: 'logo' | 'mark' | 'person' | 'agent' | 'file' | 'live' | 'approval'; x: number; y: number; tilt: number; color?: string; ink?: string }

const STICKERS: Sticker[] = [
  { label: 'approved · CL', kind: 'approval', x: 4, y: 46, tilt: -8 },
  { label: 'Cara', kind: 'person', x: 16, y: 60, tilt: 3, color: 'var(--sticker-3)', ink: '#16171a' },
  { label: "Asha's agent", kind: 'agent', x: 34, y: 50, tilt: -3, color: 'var(--sticker-1)' },
  { label: 'Asha', kind: 'person', x: 44, y: 10, tilt: 7, color: 'var(--sticker-1)', ink: '#16171a' },
  { label: 'CONVERGE', kind: 'logo', x: 18, y: 28, tilt: -4 },
  { label: "Ben's agent", kind: 'agent', x: 50, y: 66, tilt: 6, color: 'var(--sticker-2)' },
  { label: 'Ben', kind: 'person', x: 52, y: 40, tilt: -5, color: 'var(--sticker-2)', ink: '#ffffff' },
  { label: 'checkout.ts', kind: 'file', x: 30, y: 72, tilt: -2 },
  { label: 'Live', kind: 'live', x: 64, y: 20, tilt: 11 },
  { label: 'Converge mark', kind: 'mark', x: 4, y: 18, tilt: -9 },
]

export function StickerLid() {
  return (
    <div className="lid" aria-hidden="true">
      {STICKERS.map((s, i) => (
        <span
          key={s.label}
          className={`lid-sticker lid-${s.kind}`}
          style={{ left: `${s.x}%`, top: `${s.y}%`, '--tilt': `${s.tilt}deg`, '--who': s.color, '--ink': s.ink, '--i': i } as CSSProperties}
        >
          {s.kind === 'person' && <b>{s.label.slice(0, 1)}</b>}
          {s.kind === 'mark' ? <img src="/converge-mark.svg" alt="" /> : s.label}
        </span>
      ))}
    </div>
  )
}
