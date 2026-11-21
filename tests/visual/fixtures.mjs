// Fixture API for the visual capture: one workspace with files, chat, a live session with two lanes, a pending and
// a decided approval, workspace memory with a stale note, and part of the day's agent budget spent. Shapes follow
// apps/web/src/api.ts. All names and data are illustrative.
export const W = '1f6c2d9a-1111-4000-8000-00000000000a'
const S = '5e5e5e5e-5555-4000-8000-000000000005'
const now = '2026-11-21T09:30:00Z'

const asha = { id: 'b3c1e2a4-0000-4000-8000-000000000001', email: 'asha@example.test', displayName: 'Asha Rao' }
const ben = { id: 'c9d2f3b5-0000-4000-8000-000000000002', displayName: 'Ben Okafor' }
const cara = { id: 'd4e5f6a7-0000-4000-8000-000000000003', displayName: 'Cara Lindqvist' }

const workspaces = [
  { id: W, name: 'Checkout service', slug: 'checkout', status: 'ACTIVE', role: 'OWNER' },
  { id: '7a2b4c6d-2222-4000-8000-00000000000b', name: 'Mobile onboarding', slug: 'mobile', status: 'ACTIVE', role: 'EDITOR' },
  { id: '9e8d7c6b-3333-4000-8000-00000000000c', name: 'Docs site', slug: 'docs', status: 'ACTIVE', role: 'VIEWER' },
  { id: '5c4b3a29-4444-4000-8000-00000000000d', name: 'Billing 2025', slug: 'billing', status: 'ARCHIVED', role: 'EDITOR' },
]

const file = (id, parentId, name, kind, path, language = null) => ({ id, workspaceId: W, parentId, name, kind, path, language, rowVersion: 1 })
const tree = [
  file('f-src', null, 'src', 'FOLDER', 'src'),
  file('f-1', 'f-src', 'checkout.ts', 'FILE', 'src/checkout.ts', 'typescript'),
  file('f-2', 'f-src', 'cart.ts', 'FILE', 'src/cart.ts', 'typescript'),
  file('f-tests', null, 'tests', 'FOLDER', 'tests'),
  file('f-3', 'f-tests', 'checkout.test.ts', 'FILE', 'tests/checkout.test.ts', 'typescript'),
  file('f-4', null, 'README.md', 'FILE', 'README.md', 'markdown'),
  file('f-5', null, 'package.json', 'FILE', 'package.json', 'json'),
]

const chat = [
  { id: 'c1', workspaceId: W, userId: ben.id, displayName: ben.displayName, body: 'Pushed the retry wrapper. Can someone look at the tax rounding?', createdAt: now },
  { id: 'c2', workspaceId: W, userId: asha.id, displayName: asha.displayName, body: 'On it. My agent is drafting tests for the edge cases.', createdAt: now },
  { id: 'c3', workspaceId: W, userId: cara.id, displayName: cara.displayName, body: 'I hold lines 40–58 in checkout.ts while I rework the discount path.', createdAt: now },
]

const card = {
  id: S, task: 'Harden checkout: round tax per line', status: 'ACTIVE', driverId: asha.id, driverName: asha.displayName, rowVersion: 3,
  participants: [{ userId: asha.id, displayName: asha.displayName, mode: 'LANE' }, { userId: ben.id, displayName: ben.displayName, mode: 'LANE' }],
  stepsDone: 1, stepsTotal: 3, files: ['src/checkout.ts', 'tests/checkout.test.ts'], runningTurns: 1, createdAt: now, endedAt: null,
}
const card2 = {
  ...card, id: 'aaaa0000-0000-4000-8000-00000000000a', task: 'Retry wrapper for the payment client', status: 'AWAITING_TAKEOVER',
  driverId: ben.id, driverName: ben.displayName, runningTurns: 0, stepsDone: 2, files: ['src/pay.ts'],
}
const plan = [
  { id: 'p1', position: 1, title: 'Round tax per line, not per order', ownerId: asha.id, ownerName: asha.displayName, status: 'DONE', rowVersion: 2 },
  { id: 'p2', position: 2, title: 'Cover the rounding edge cases in tests', ownerId: ben.id, ownerName: ben.displayName, status: 'IN_PROGRESS', rowVersion: 1 },
  { id: 'p3', position: 3, title: 'Open the pull request', ownerId: null, ownerName: null, status: 'TODO', rowVersion: 0 },
]
const turn = (id, who, status, events) => ({
  id, sessionId: S, laneUserId: who.id, sponsorId: who.id, sponsorName: who.displayName.split(' ')[0], model: 'claude-opus-5-5', status, error: null,
  costMicros: 120000, costCapMicros: 2000000, startedAt: now, endedAt: status === 'RUNNING' ? null : now, revertStatus: null, revertible: status !== 'RUNNING', events,
})
const turns = [
  turn('t1', asha, 'SUCCEEDED', [
    { seq: 1, kind: 'prompt', text: 'Round tax to the cent per line item.' },
    { seq: 2, kind: 'tool', ok: true, summary: 'read src/checkout.ts' },
    { seq: 3, kind: 'tool', ok: true, summary: 'edited src/checkout.ts' },
    { seq: 4, kind: 'approval', approvalId: 'ap0' },
    { seq: 5, kind: 'text', text: 'Tax now rounds per line; totals match the invoice service.' },
  ]),
  turn('t2', ben, 'RUNNING', [
    { seq: 1, kind: 'prompt', text: 'Write tests for 0.005 and negative discounts, then run them.' },
    { seq: 2, kind: 'tool', ok: true, summary: 'created tests/checkout.test.ts' },
    { seq: 3, kind: 'tool', ok: false, summary: 'run_command: "rm -rf build" was denied by Asha; it did not run.' },
    { seq: 4, kind: 'approval', approvalId: 'ap1' },
  ]),
]
const pending = {
  id: 'ap1', sessionId: S, turnId: 't2', requestedBy: ben.id, requesterName: 'Ben', command: 'npm test -- checkout',
  capabilities: ['run a command in the sandbox (no network)'], status: 'PENDING', decidedBy: null, deciderName: null, rowVersion: 0,
  expiresAt: '2026-11-21T09:45:00Z', createdAt: now, job: null,
}
const job = { id: 'j0', approvalId: 'ap0', command: 'npm run typecheck', status: 'SUCCEEDED', exitCode: 0, error: null, outcome: null, createdAt: now, startedAt: now, endedAt: now }
const approved = {
  ...pending, id: 'ap0', turnId: 't1', requestedBy: asha.id, requesterName: 'Asha', command: 'npm run typecheck',
  status: 'APPROVED', decidedBy: ben.id, deciderName: ben.displayName, job,
}
const memories = [
  {
    id: 'm1', fileId: 'f-1', path: 'src/checkout.ts', kind: 'GOTCHA', body: 'Tax rounds per line, not per order: the invoice service does the same.',
    anchor: { start: 0, end: 10 }, anchoredText: 'const tax', currentText: 'const tax', similarity: 1, status: 'ACTIVE',
    createdBy: asha.id, authorName: asha.displayName, createdInTurn: null, rowVersion: 1, updatedAt: now,
  },
  {
    id: 'm2', fileId: 'f-1', path: 'src/checkout.ts', kind: 'DECISION', body: 'Discounts apply before tax.',
    anchor: { start: 20, end: 40 }, anchoredText: 'applyDiscount(subtotal)', currentText: 'applyDiscount(subtotal, cart.coupon)', similarity: 0.6, status: 'STALE',
    createdBy: ben.id, authorName: ben.displayName, createdInTurn: 't1', rowVersion: 1, updatedAt: now,
  },
]

/** [path pattern, JSON body] pairs for GET requests; anything unmatched answers []. */
export const api = [
  [/\/auth\/csrf$/, {}],
  [/\/auth\/me$/, asha],
  [/\/workspaces$/, workspaces],
  [/\/workspaces\/[^/]+$/, workspaces[0]],
  [/\/tree$/, tree],
  [/\/chat$/, chat],
  [/\/members$/, { members: [{ userId: asha.id, email: asha.email, displayName: asha.displayName, role: 'OWNER', joinedAt: now }], invitations: [] }],
  [/\/provider-keys\/anthropic$/, { configured: true, hint: 'sk-ant-…7Q2x' }],
  [/\/agent-spend$/, { spentMicros: 7_400_000, dailyCapMicros: 20_000_000, turnCapMicros: 2_000_000 }],
  [/\/files\/[^/]+\/content$/, { fileId: 'f-1', path: 'src/checkout.ts', language: 'typescript', text: '', version: 1 }],
  [/\/sessions$/, [card, card2]],
  [/\/sessions\/[^/]+$/, { session: card, plan, turns }],
  [/\/agent\/turns$/, turns],
  [/\/approvals$/, [pending, approved]],
  [/\/jobs\/[^/]+$/, { job, output: [{ seq: 1, stream: 'system', chunk: '$ npm run typecheck\n' }, { seq: 2, stream: 'stdout', chunk: 'tsc --noEmit\nDone in 2.1s\n' }] }],
  [/\/comments$/, []],
  [/\/memories$/, memories],
  [/\/locks$/, []],
]
