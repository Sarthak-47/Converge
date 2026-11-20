// Fault injection with Toxiproxy (design §22.6): the stack runs with the "chaos" profile, which routes the
// collaboration service's database connection and the API's calls to the collaboration service through
// Toxiproxy. Each scenario injects a fault, keeps people typing or saving, removes the fault and checks that
// nothing was lost. Writes .tmp/faults.json and prints Markdown.
//
//   COMPOSE_PROFILES=fake-model,chaos COLLAB_DB_HOST=toxiproxy COLLAB_DB_PORT=15432 \
//     API_COLLAB_URL=http://toxiproxy:11234 docker compose up -d --build
//   node tests/chaos/faults.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { origin, person, sleep } from '../load/stack.mjs'

const TOXIPROXY = process.env.TOXIPROXY_URL ?? 'http://localhost:8474'

async function toxiproxy(method, path, body) {
  const response = await fetch(`${TOXIPROXY}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok && response.status !== 404) throw new Error(`toxiproxy ${method} ${path}: ${response.status} ${await response.text()}`)
}
const addToxic = (proxy, name, type, attributes, stream = 'downstream') =>
  toxiproxy('POST', `/proxies/${proxy}/toxics`, { name, type, stream, toxicity: 1, attributes })
const removeToxic = (proxy, name) => toxiproxy('DELETE', `/proxies/${proxy}/toxics/${name}`)
const setEnabled = (proxy, enabled) => toxiproxy('POST', `/proxies/${proxy}`, { enabled })

class OriginSocket extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { headers: { Origin: origin } })
  }
}

/** A live editor on one file. */
function editor(owner, fileId) {
  const doc = new Y.Doc()
  const socket = new HocuspocusProviderWebsocket({ url: `${origin.replace(/^http/, 'ws')}/collab`, WebSocketPolyfill: OriginSocket })
  let synced
  const ready = new Promise((resolve) => (synced = resolve))
  const provider = new HocuspocusProvider({
    websocketProvider: socket, name: fileId, document: doc,
    token: async () => (await owner.session.request('POST', '/api/v1/realtime/tickets', { fileId })).ticket,
    onSynced: () => synced(),
  })
  provider.attach()
  const text = doc.getText('content')
  let seq = 0
  return {
    text, ready,
    type(tag) {
      const marker = `[${tag}${++seq}]`
      text.insert(text.length, marker)
      return marker
    },
    destroy() {
      provider.destroy()
      socket.destroy()
    },
  }
}

/** Polls until `check` passes; returns the time it took, or null on timeout. */
async function within(ms, check) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await check().catch(() => false)) return Date.now() - start
    await sleep(500)
  }
  return null
}

const stored = (owner, fileId) => owner.session.request('GET', `/api/v1/files/${fileId}/content`).then((c) => c.text)

async function setup(name) {
  const owner = await person(name)
  const workspace = await owner.session.request('POST', '/api/v1/workspaces', { name: `Faults ${name}` })
  const file = await owner.session.request('POST', '/api/v1/files', { workspaceId: workspace.id, parentId: null, name: 'notes.txt', kind: 'FILE' })
  const a = editor(owner, file.id)
  const b = editor(owner, file.id)
  await Promise.all([a.ready, b.ready])
  return { owner, fileId: file.id, a, b }
}

const results = []

/** The collaboration service's database is slow: typing still converges and is stored, only later. */
async function slowDatabase() {
  const { owner, fileId, a, b } = await setup('slowdb')
  await addToxic('collab-postgres', 'slow', 'latency', { latency: 400, jitter: 100 })
  const markers = []
  for (let i = 0; i < 20; i++) {
    markers.push(a.type('a'), b.type('b'))
    await sleep(200)
  }
  const converged = await within(15_000, async () => a.text.toString() === b.text.toString() && markers.every((m) => a.text.toString().includes(m)))
  const storedMs = await within(30_000, async () => (await stored(owner, fileId)) === a.text.toString())
  await removeToxic('collab-postgres', 'slow')
  a.destroy(); b.destroy()
  results.push({ scenario: 'Database 400 ms slower (±100 ms)', converged: converged !== null, convergedMs: converged, storedMs, ok: converged !== null && storedMs !== null })
}

/** The database connection is cut while people type: stores fail, nothing is lost, all is stored after. */
async function databaseDown() {
  const { owner, fileId, a, b } = await setup('dbdown')
  await setEnabled('collab-postgres', false)
  const markers = []
  for (let i = 0; i < 20; i++) {
    markers.push(a.type('a'), b.type('b'))
    await sleep(400)
  }
  const convergedWhileDown = await within(10_000, async () => a.text.toString() === b.text.toString() && markers.every((m) => a.text.toString().includes(m)))
  await setEnabled('collab-postgres', true)
  const storedMs = await within(45_000, async () => {
    const text = await stored(owner, fileId)
    return markers.every((m) => text.includes(m)) && text === a.text.toString()
  })
  a.destroy(); b.destroy()
  results.push({ scenario: 'Database unreachable for ~8 s while typing', convergedWhileDown: convergedWhileDown !== null, storedAfterRecoveryMs: storedMs, ok: convergedWhileDown !== null && storedMs !== null })
}

/** The API cannot reach the collaboration service: an external change fails cleanly and changes nothing. */
async function collabUnreachable() {
  const { owner, fileId, a, b } = await setup('collabdown')
  a.type('before')
  const before = await within(15_000, async () => (await stored(owner, fileId)) === a.text.toString())
  const expected = a.text.toString()
  await setEnabled('api-collab', false)
  let status = null
  const started = Date.now()
  try {
    await owner.session.request('PUT', `/api/v1/files/${fileId}/content`, { text: `${expected}\nwritten through the API` })
    status = 200
  } catch (error) {
    status = Number(/: (\d{3}) /.exec(error.message)?.[1] ?? 0)
  }
  const failedAfterMs = Date.now() - started
  await sleep(1000)
  const unchanged = a.text.toString() === expected && b.text.toString() === expected
  await setEnabled('api-collab', true)
  const recovered = await within(20_000, async () => {
    await owner.session.request('PUT', `/api/v1/files/${fileId}/content`, { text: `${expected}\nwritten after recovery` })
    return a.text.toString().includes('written after recovery')
  })
  a.destroy(); b.destroy()
  results.push({
    scenario: 'API cannot reach the collaboration service', initialStore: before !== null, status, failedAfterMs, unchanged, recoveredMs: recovered,
    ok: status === 503 && unchanged && recovered !== null,
  })
}

try {
  await slowDatabase()
  await databaseDown()
  await collabUnreachable()
} finally {
  await removeToxic('collab-postgres', 'slow').catch(() => undefined)
  await setEnabled('collab-postgres', true).catch(() => undefined)
  await setEnabled('api-collab', true).catch(() => undefined)
}

const ms = (v) => (v === null || v === undefined ? 'n/a' : `${v} ms`)
const markdown = [
  `## Fault injection (${new Date().toISOString()})`,
  '',
  '| Scenario | Result |',
  '|---|---|',
  ...results.map((r) => {
    if ('convergedMs' in r) return `| ${r.scenario} | ${r.ok ? 'passed' : 'FAILED'}: converged in ${ms(r.convergedMs)}, stored ${ms(r.storedMs)} later |`
    if ('storedAfterRecoveryMs' in r) return `| ${r.scenario} | ${r.ok ? 'passed' : 'FAILED'}: replicas converged while the database was down; everything stored ${ms(r.storedAfterRecoveryMs)} after it returned |`
    return `| ${r.scenario} | ${r.ok ? 'passed' : 'FAILED'}: the API answered ${r.status} after ${ms(r.failedAfterMs)} and changed nothing${r.unchanged ? '' : ' (TEXT CHANGED)'}; worked again ${ms(r.recoveredMs)} after recovery |`
  }),
].join('\n')
mkdirSync('.tmp', { recursive: true })
writeFileSync('.tmp/faults.json', JSON.stringify(results, null, 2))
console.log(markdown)
process.exit(results.every((r) => r.ok) ? 0 : 1)
