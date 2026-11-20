// Shared by the baseline and fault-injection scripts: signed-in sessions against a running stack.
export const BASE = process.env.BASELINE_URL ?? 'http://localhost:8000'
export const origin = new URL(BASE).origin
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A signed-in person: cookies, CSRF, JSON requests. */
export class Session {
  cookies = new Map()
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  remember(response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';')
      const i = pair.indexOf('=')
      this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
    }
  }
  async request(method, path, body) {
    if (method !== 'GET' && !this.cookies.has('XSRF-TOKEN')) {
      this.remember(await fetch(`${BASE}/api/v1/auth/csrf`, { headers: { Cookie: this.header() } }))
    }
    const headers = { Cookie: this.header() }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (method !== 'GET') headers['X-XSRF-TOKEN'] = this.cookies.get('XSRF-TOKEN') ?? ''
    const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    this.remember(response)
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
}

export async function person(name) {
  const session = new Session()
  const email = `load-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`
  const user = await session.request('POST', '/api/v1/auth/register', { email, displayName: name, password: 'correct horse battery' })
  return { session, email, id: user.id, name }
}
