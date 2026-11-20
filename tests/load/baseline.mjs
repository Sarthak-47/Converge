// Baseline load and chaos run against a running stack (design §22.4, §22.6, Phase 13).
//
//   node tests/load/baseline.mjs            (stack at http://localhost:8000, fake model and RATE_LIMIT_SCALE raised)
//
// Real Yjs clients join documents through nginx exactly as browsers do (single-use tickets, Origin header).
// They type continuously with an artificial 50-300 ms send delay; latency is measured in one process, so the
// clock is shared. Mid-run, 10% of clients reconnect and (with CHAOS=1) the collaboration service is
// restarted; the report gives propagation percentiles, convergence, recovery times, message amplification
// and the cost of scripted agent turns from the ledger. Writes .tmp/baseline.json and prints Markdown.
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { BASE, origin, person, sleep } from './stack.mjs'

const CLIENTS = Number(process.env.CLIENTS ?? 40)
const WORKSPACES = Number(process.env.WORKSPACES ?? 4)
const FILES = Number(process.env.FILES_PER_WORKSPACE ?? 2)
const DURATION_MS = Number(process.env.DURATION_MS ?? 60_000)
const TYPE_EVERY_MS = Number(process.env.TYPE_EVERY_MS ?? 700)
const CHAOS = process.env.CHAOS === '1'
const AGENT_TURNS = Number(process.env.AGENT_TURNS ?? 5)
const percentile = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))])
}

/** A WebSocket whose sends are delayed 50-300 ms, as on a slow network. */
class SlowSocket extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { headers: { Origin: origin } })
  }
  send(data, ...rest) {
    setTimeout(() => {
      if (this.readyState === WebSocket.OPEN) super.send(data, ...rest)
    }, 50 + Math.random() * 250)
  }
}

const stats = { sent: 0, received: 0, latencies: [], reconnects: [], chaosRecoveryMs: null, errors: 0 }

function client(owner, fileId, index) {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const socket = new HocuspocusProviderWebsocket({ url: `${origin.replace(/^http/, 'ws')}/collab`, WebSocketPolyfill: SlowSocket })
  let synced = false
  let syncedResolvers = []
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: fileId,
    document: doc,
    token: async () => (await owner.session.request('POST', '/api/v1/realtime/tickets', { fileId })).ticket,
    onSynced: () => {
      synced = true
      syncedResolvers.forEach((resolve) => resolve())
      syncedResolvers = []
    },
  })
  provider.attach()
  // Every marker another client wrote is timed when it first appears here.
  const seen = new Set()
  text.observe((event, transaction) => {
    if (transaction.local) return
    for (const delta of event.changes.delta) {
      if (typeof delta.insert !== 'string') continue
      for (const match of delta.insert.matchAll(/«(\d+):(\d+):(\d+)»/g)) {
        const [, from, seq, sentAt] = match
        if (Number(from) === index) continue
        const key = `${from}:${seq}`
        if (seen.has(key)) continue
        seen.add(key)
        stats.received++
        stats.latencies.push(Date.now() - Number(sentAt))
      }
    }
  })
  let seq = 0
  return {
    fileId,
    doc,
    text,
    provider,
    socket,
    whenSynced: () => (synced ? Promise.resolve() : new Promise((resolve) => syncedResolvers.push(resolve))),
    markUnsynced: () => {
      synced = false
    },
    type() {
      if (!synced) return
      const marker = `«${index}:${++seq}:${Date.now()}»`
      doc.transact(() => text.insert(Math.floor(Math.random() * (text.length + 1)), marker))
      stats.sent++
    },
    destroy() {
      provider.destroy()
      socket.destroy()
    },
  }
}

async function main() {
  console.error(`Setting up ${WORKSPACES} workspaces x ${FILES} files, ${CLIENTS} clients against ${BASE}`)
  const owners = []
  const files = []
  for (let w = 0; w < WORKSPACES; w++) {
    const owner = await person(`owner${w}`)
    const workspace = await owner.session.request('POST', '/api/v1/workspaces', { name: `Load ${w}` })
    owners.push(owner)
    for (let f = 0; f < FILES; f++) {
      const file = await owner.session.request('POST', '/api/v1/files', { workspaceId: workspace.id, parentId: null, name: `f${f}.txt`, kind: 'FILE' })
      files.push({ owner, fileId: file.id, workspaceId: workspace.id })
    }
  }

  const clients = []
  for (let i = 0; i < CLIENTS; i++) {
    const target = files[i % files.length]
    clients.push(client(target.owner, target.fileId, i))
  }
  const joinStart = Date.now()
  await Promise.all(clients.map((c) => c.whenSynced()))
  const initialSyncMs = Date.now() - joinStart
  console.error(`All ${CLIENTS} clients synced in ${initialSyncMs} ms; typing for ${DURATION_MS / 1000} s`)

  const typingStart = Date.now()
  const typing = clients.map((c) => setInterval(() => c.type(), TYPE_EVERY_MS * (0.5 + Math.random())))

  // Reconnect 10% of clients a third of the way in; measure how long until each has synced again.
  await sleep(DURATION_MS / 3)
  const reconnecting = clients.filter((_, i) => i % 10 === 0)
  await Promise.all(reconnecting.map(async (c) => {
    const t0 = Date.now()
    c.markUnsynced()
    c.socket.disconnect()
    await sleep(500)
    await c.socket.connect()
    await c.whenSynced()
    stats.reconnects.push(Date.now() - t0 - 500)
  }))

  // Chaos: restart the collaboration service; clients must reconnect on their own and converge.
  if (CHAOS) {
    await sleep(DURATION_MS / 6)
    console.error('Restarting the collaboration service')
    clients.forEach((c) => c.markUnsynced())
    const t0 = Date.now()
    execSync('docker compose restart collab', { stdio: 'ignore' })
    await Promise.all(clients.map((c) => c.whenSynced()))
    stats.chaosRecoveryMs = Date.now() - t0
    console.error(`All clients synced again ${stats.chaosRecoveryMs} ms after the restart began`)
  }

  await sleep(Math.max(0, typingStart + DURATION_MS - Date.now()))
  typing.forEach(clearInterval)

  // Convergence: once quiet, every replica of a file must be identical.
  const quietStart = Date.now()
  let converged = false
  while (Date.now() - quietStart < 30_000) {
    await sleep(500)
    converged = files.every((f) => {
      const replicas = clients.filter((c) => c.fileId === f.fileId).map((c) => c.text.toString())
      return replicas.every((t) => t === replicas[0])
    })
    if (converged) break
  }
  const convergenceMs = Date.now() - quietStart

  let collabStats = null
  try {
    collabStats = execSync('docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}}"').toString()
      .split('\n').filter((l) => /collab|api-1|nginx/.test(l)).join('\n')
  } catch {
    // docker not reachable from here
  }

  const cost = await agentCost(owners[0]).catch((error) => ({ error: error.message }))
  clients.forEach((c) => c.destroy())

  const peers = CLIENTS / files.length - 1
  const report = {
    when: new Date().toISOString(),
    scenario: { clients: CLIENTS, workspaces: WORKSPACES, files: files.length, durationMs: DURATION_MS, typeEveryMs: TYPE_EVERY_MS, sendDelayMs: '50-300', chaos: CHAOS },
    initialSyncMs,
    propagationMs: { p50: percentile(stats.latencies, 50), p95: percentile(stats.latencies, 95), p99: percentile(stats.latencies, 99), max: percentile(stats.latencies, 100), samples: stats.latencies.length },
    updates: { sent: stats.sent, receivedByPeers: stats.received, expectedPerUpdate: peers, deliveryRatio: stats.sent ? +(stats.received / (stats.sent * peers)).toFixed(4) : null },
    reconnectRecoveryMs: { p50: percentile(stats.reconnects, 50), p95: percentile(stats.reconnects, 95), clients: stats.reconnects.length },
    chaosRecoveryMs: stats.chaosRecoveryMs,
    converged,
    convergenceAfterQuietMs: convergenceMs,
    containers: collabStats,
    agentCost: cost,
  }
  mkdirSync('.tmp', { recursive: true })
  writeFileSync('.tmp/baseline.json', JSON.stringify(report, null, 2))
  console.log(markdown(report))
  if (!converged) process.exitCode = 1
}

/** Runs scripted agent turns through the real API, runner and fake model, then reads the cost ledger. */
async function agentCost(owner) {
  const workspace = await owner.session.request('POST', '/api/v1/workspaces', { name: 'Agent cost' })
  await owner.session.request('POST', '/api/v1/files', { workspaceId: workspace.id, parentId: null, name: 'app.ts', kind: 'FILE' })
  await owner.session.request('PUT', '/api/v1/me/provider-keys/anthropic', { apiKey: 'sk-ant-test-baseline-000000001' })
  const session = await owner.session.request('POST', `/api/v1/workspaces/${workspace.id}/sessions`, { task: 'Baseline turns' })
  const prompt = ['@tool list_files {}', '@tool read_file {"path":"app.ts"}', '@tool search {"query":"x"}'].join('\n')
  const turns = []
  for (let i = 0; i < AGENT_TURNS; i++) {
    const turn = await owner.session.request('POST', `/api/v1/workspaces/${workspace.id}/agent/turns`, { prompt, sessionId: session.id })
    const t0 = Date.now()
    let current = turn
    while (current.status === 'RUNNING' && Date.now() - t0 < 60_000) {
      await sleep(250)
      current = (await owner.session.request('GET', `/api/v1/workspaces/${workspace.id}/agent/turns?sessionId=${session.id}`)).find((t) => t.id === turn.id)
    }
    turns.push({ status: current.status, costMicros: current.costMicros, durationMs: Date.now() - t0 })
  }
  const costs = turns.map((t) => t.costMicros)
  return {
    model: 'claude-opus-5-5 (scripted fake model: 1000 input + 200 output tokens per response)',
    turns: turns.length,
    statuses: [...new Set(turns.map((t) => t.status))],
    costMicros: { p50: percentile(costs, 50), p95: percentile(costs, 95) },
    turnDurationMs: { p50: percentile(turns.map((t) => t.durationMs), 50), p95: percentile(turns.map((t) => t.durationMs), 95) },
  }
}

function markdown(r) {
  const ms = (v) => (v === null || v === undefined ? 'n/a' : `${v} ms`)
  return [
    `## Baseline (${r.when})`,
    '',
    `Scenario: ${r.scenario.clients} clients on ${r.scenario.files} files in ${r.scenario.workspaces} workspaces, ${r.scenario.durationMs / 1000} s of typing (one edit every ~${r.scenario.typeEveryMs} ms per client), ${r.scenario.sendDelayMs} ms artificial send delay${r.scenario.chaos ? ', collaboration service restarted mid-run' : ''}.`,
    '',
    '| Measure | Result |',
    '|---|---|',
    `| Initial sync of all clients | ${ms(r.initialSyncMs)} |`,
    `| Update propagation p50 / p95 / p99 / max | ${ms(r.propagationMs.p50)} / ${ms(r.propagationMs.p95)} / ${ms(r.propagationMs.p99)} / ${ms(r.propagationMs.max)} (${r.propagationMs.samples} samples) |`,
    `| Updates delivered to peers | ${r.updates.receivedByPeers} of ${r.updates.sent} × ${r.updates.expectedPerUpdate} (ratio ${r.updates.deliveryRatio}) |`,
    `| Reconnect recovery p50 / p95 (${r.reconnectRecoveryMs.clients} clients) | ${ms(r.reconnectRecoveryMs.p50)} / ${ms(r.reconnectRecoveryMs.p95)} |`,
    `| Recovery after restarting the collaboration service | ${ms(r.chaosRecoveryMs)} |`,
    `| Converged after typing stopped | ${r.converged ? `yes, within ${ms(r.convergenceAfterQuietMs)}` : 'NO'} |`,
    `| Cost per agent turn p50 / p95 | ${r.agentCost.costMicros ? `$${(r.agentCost.costMicros.p50 / 1e6).toFixed(4)} / $${(r.agentCost.costMicros.p95 / 1e6).toFixed(4)} (${r.agentCost.turns} turns, ${r.agentCost.model})` : r.agentCost.error} |`,
    '',
    r.containers ? `Containers at the end:\n\n\`\`\`\n${r.containers}\n\`\`\`` : '',
  ].join('\n')
}

await main()
process.exit(process.exitCode ?? 0)
