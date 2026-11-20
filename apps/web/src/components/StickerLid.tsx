import type { CSSProperties } from 'react'

// The sign-in lid: a workspace as a laptop lid with its people, their agents and its file stuck on it. Every sticker
// is something the product shows inside (a person, their agent, the shared file, Live, a named approval). The names
// are illustrative, not real users.
type Sticker = { label: string; kind: 'logo' | 'person' | 'agent' | 'file' | 'live' | 'approval'; x: number; y: number; tilt: number; color?: string }

const STICKERS: Sticker[] = [
  { label: 'CONVERGE', kind: 'logo', x: 8, y: 10, tilt: -4 },
  { label: 'Asha', kind: 'person', x: 52, y: 8, tilt: 5, color: 'var(--sticker-1)' },
  { label: 'Ben', kind: 'person', x: 70, y: 26, tilt: -6, color: 'var(--sticker-2)' },
  { label: 'Cara', kind: 'person', x: 14, y: 52, tilt: 3, color: 'var(--sticker-3)' },
  { label: "Asha's agent", kind: 'agent', x: 40, y: 38, tilt: -3, color: 'var(--sticker-1)' },
  { label: "Ben's agent", kind: 'agent', x: 60, y: 62, tilt: 4, color: 'var(--sticker-2)' },
  { label: 'checkout.ts', kind: 'file', x: 24, y: 72, tilt: -2 },
  { label: 'Live', kind: 'live', x: 76, y: 6, tilt: 8 },
  { label: 'approved · CL', kind: 'approval', x: 6, y: 32, tilt: -7 },
]

export function StickerLid() {
  return (
    <div className="lid" aria-hidden="true">
      {STICKERS.map((s, i) => (
        <span
          key={s.label}
          className={`lid-sticker lid-${s.kind}`}
          style={{ left: `${s.x}%`, top: `${s.y}%`, '--tilt': `${s.tilt}deg`, '--who': s.color, '--i': i } as CSSProperties}
        >
          {s.kind === 'person' && <b>{s.label.slice(0, 1)}</b>}
          {s.label}
        </span>
      ))}
    </div>
  )
}
