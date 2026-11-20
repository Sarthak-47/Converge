import type { CSSProperties } from 'react'

/** A small, stable tilt for someone's sticker, so it always sits on the lid the same way (between -3 and 3 degrees). */
export function tiltFor(id: string): number {
  let hash = 7
  for (const ch of id) hash = (hash * 33 + ch.charCodeAt(0)) | 0
  return ((Math.abs(hash) % 13) - 6) / 2
}

/** Inline style for a sticker in `color`, tilted for `id`. */
export function stickerStyle(id: string, color?: string): CSSProperties {
  return { '--tilt': `${tiltFor(id)}deg`, ...(color ? { '--who': color } : {}) } as CSSProperties
}

/** One or two initials for a person sticker. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2)).toUpperCase()
}
