import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SyncBridge } from '../src/bridge.js'
import { HttpRemoteWorkspace } from '../src/httpRemote.js'

/**
 * Gate F against the real stack: two desktop bridges for one person, each with its own checkout, synced
 * through the real API and collaboration service. Runs only when CONVERGE_LIVE_URL points at a running
 * stack (CI sets it after `docker compose up`).
 */
const baseUrl = process.env.CONVERGE_LIVE_URL
const SCRATCH = path.resolve(import.meta.dirname, '../../../.tmp/sync-live')

async function signUp(): Promise<Record<string, string>> {
  const cookies: Record<string, string> = {}
  const keep = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';')
      const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]
      if (value) cookies[name] = value
      else delete cookies[name]
    }
  }
  const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
  keep(await fetch(`${baseUrl}/api/v1/auth/csrf`))
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': cookies['XSRF-TOKEN'], Cookie: cookieHeader() },
    body: JSON.stringify({ email: `desktop-${Date.now()}@example.test`, displayName: 'Desktop', password: 'correct horse battery' }),
  })
  expect(response.status).toBe(201)
  keep(response)
  return { CONVERGE_SESSION: cookies['CONVERGE_SESSION'] }
}

async function api(cookies: Record<string, string>, method: string, url: string, body?: unknown) {
  const jar = { ...cookies }
  const csrf = await fetch(`${baseUrl}/api/v1/auth/csrf`, { headers: { Cookie: `CONVERGE_SESSION=${jar.CONVERGE_SESSION}` } })
  const token = csrf.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('XSRF-TOKEN='))?.slice(11) ?? ''
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': token, Cookie: `CONVERGE_SESSION=${jar.CONVERGE_SESSION}; XSRF-TOKEN=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}`)
  return response.status === 204 ? null : response.json()
}

const poll = (check: () => Promise<unknown>, timeout = 20_000) => expect.poll(check, { timeout, interval: 200 })

describe.skipIf(!baseUrl)('desktop sync against the live stack', () => {
  let cookies: Record<string, string>
  let workspaceId: string
  const machines: Array<{ bridge: SyncBridge; remote: HttpRemoteWorkspace; root: string }> = []

  beforeAll(async () => {
    cookies = await signUp()
    workspaceId = ((await api(cookies, 'POST', '/api/v1/workspaces', { name: 'Desktop sync' })) as { id: string }).id
    const file = (await api(cookies, 'POST', '/api/v1/files', { workspaceId, name: 'shared.txt', kind: 'FILE' })) as { id: string }
    await api(cookies, 'PUT', `/api/v1/files/${file.id}/content`, { text: 'from the workspace\n' })
    for (const name of ['laptop', 'desktop']) {
      const root = path.join(SCRATCH, `${name}-${Date.now()}`)
      await mkdir(root, { recursive: true })
      const remote = new HttpRemoteWorkspace({ baseUrl: baseUrl!, workspaceId, cookies })
      const bridge = new SyncBridge({ root, remote })
      await bridge.start()
      machines.push({ bridge, remote, root })
    }
  }, 60_000)

  afterAll(async () => {
    for (const m of machines) {
      await m.bridge.stop()
      await m.remote.destroy()
      await rm(m.root, { recursive: true, force: true })
    }
  })

  it('mirrors the workspace into every checkout', async () => {
    for (const m of machines) {
      await poll(() => readFile(path.join(m.root, 'shared.txt'), 'utf8').catch(() => '')).toBe('from the workspace\n')
    }
  })

  it('carries a local save on one machine to the other machine and the workspace', async () => {
    const [laptop, desktop] = machines
    await writeFile(path.join(laptop.root, 'shared.txt'), 'from the workspace\nsaved on the laptop\n')

    await poll(() => readFile(path.join(desktop.root, 'shared.txt'), 'utf8')).toBe('from the workspace\nsaved on the laptop\n')
  })

  it('creates files that appear in a checkout', async () => {
    const [laptop, desktop] = machines
    await mkdir(path.join(laptop.root, 'src'), { recursive: true })
    await writeFile(path.join(laptop.root, 'src', 'created.ts'), 'export const fromDisk = true\n')

    await poll(() => readFile(path.join(desktop.root, 'src', 'created.ts'), 'utf8').catch(() => '')).toBe('export const fromDisk = true\n')
    const tree = (await api(cookies, 'GET', `/api/v1/workspaces/${workspaceId}/tree`)) as Array<{ path: string }>
    expect(tree.map((n) => n.path)).toContain('src/created.ts')
  })
})
