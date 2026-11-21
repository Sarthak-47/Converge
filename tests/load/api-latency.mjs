// API request latency: times sequential authenticated GET /api/v1/workspaces through nginx and prints
// p50/p95/p99. Used to check that span export costs nothing measurable (docs/BASELINE.md).
//   BASE_URL=http://127.0.0.1:8000 node tests/load/api-latency.mjs "label"
const base = process.env.BASE_URL ?? 'http://127.0.0.1:8000'
const jar = new Map()
const cookies = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
const keep = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)) } }
const origin = { Origin: 'http://localhost:8000' }
keep(await fetch(`${base}/api/v1/auth/csrf`, { headers: origin }))
const email = `latency-${Date.now()}@example.test`
const reg = await fetch(`${base}/api/v1/auth/register`, {
  method: 'POST',
  headers: { ...origin, 'Content-Type': 'application/json', 'X-XSRF-TOKEN': jar.get('XSRF-TOKEN'), Cookie: cookies() },
  body: JSON.stringify({ email, displayName: 'Latency', password: 'correct horse battery' }),
})
keep(reg)
if (reg.status !== 201) throw new Error(`register ${reg.status}`)
const times = []
for (let i = 0; i < 2200; i++) {
  const t = performance.now()
  const r = await fetch(`${base}/api/v1/workspaces`, { headers: { ...origin, Cookie: cookies() } })
  await r.arrayBuffer()
  if (r.status !== 200) throw new Error(`status ${r.status}`)
  if (i >= 200) times.push(performance.now() - t) // the first 200 warm up
}
times.sort((a, b) => a - b)
const q = (p) => times[Math.floor(p * (times.length - 1))].toFixed(2)
console.log(`${process.argv[2]}: n=${times.length} p50=${q(0.5)} p95=${q(0.95)} p99=${q(0.99)} ms`)
