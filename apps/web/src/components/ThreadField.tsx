// The sign-in illustration: each thread is a collaborator, person or agent, flowing in from the left and braiding
// into the one line that is the shared file. Names are illustrative, not real users.
const THREADS = [
  { name: 'Asha', kind: 'person', y: 70, color: 'var(--thread-1)' },
  { name: "Asha's agent", kind: 'agent', y: 150, color: 'var(--thread-4)' },
  { name: 'Ben', kind: 'person', y: 235, color: 'var(--thread-2)' },
  { name: "Ben's agent", kind: 'agent', y: 320, color: 'var(--thread-5)' },
  { name: 'Cara', kind: 'person', y: 405, color: 'var(--thread-3)' },
] as const

const MEET_X = 520
const MEET_Y = 240

export function ThreadField() {
  return (
    <svg className="thread-field" viewBox="0 0 760 480" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0V40" fill="none" stroke="var(--grid-line)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="760" height="480" fill="url(#grid)" />
      {THREADS.map((t, i) => (
        <g key={t.name} className="thread" style={{ ['--i' as string]: i }}>
          <path
            className="thread-line"
            d={`M40 ${t.y} C ${260} ${t.y}, ${360} ${MEET_Y + (t.y - MEET_Y) * 0.08}, ${MEET_X} ${MEET_Y + (t.y - MEET_Y) * 0.02}`}
            fill="none"
            stroke={t.color}
            strokeWidth={t.kind === 'agent' ? 3 : 5}
            strokeDasharray={t.kind === 'agent' ? '2 9' : undefined}
            strokeLinecap="round"
            pathLength={t.kind === 'agent' ? undefined : 1}
          />
          <circle cx="40" cy={t.y} r="7" fill={t.color} />
          <text x="58" y={t.y - 14} className="thread-label">{t.name}</text>
        </g>
      ))}
      {/* The braid: every thread carries its colour on into the shared file. */}
      {THREADS.map((t, i) => (
        <path key={t.name} className="thread-trunk" d={`M${MEET_X} ${MEET_Y + (i - 2) * 3.2}H730`} fill="none" stroke={t.color} strokeWidth="2.6" strokeLinecap="round" pathLength={1} />
      ))}
      <circle cx={MEET_X} cy={MEET_Y} r="12" fill="var(--signal)" className="thread-knot" />
      <text x={MEET_X + 24} y={MEET_Y - 22} className="thread-label strong">checkout.ts</text>
    </svg>
  )
}
