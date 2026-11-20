// One small drawn icon set (24-unit grid, 1.6 stroke, round joins) so every control speaks the same line weight.
// Icons are decorative: the control's own text or aria-label names it.
const PATHS = {
  chevron: 'M9 6l6 6-6 6',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  filePlus: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6',
  folderPlus: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cross: 'M7 7l10 10M17 7L7 17',
  sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  back: 'M19 12H5M11 6l-6 6 6 6',
  pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon-svg ${className}` : 'icon-svg'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/** Converge's mark: the name as a die-cut lemon sticker, the first sticker on the lid. */
export function BrandMark({ size = 15 }: { size?: number }) {
  return (
    <span className="logo-sticker" style={{ fontSize: size }} aria-hidden="true">
      CONVERGE
    </span>
  )
}
