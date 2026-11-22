import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Which Converge server the app opens. An installed app has no environment to set, so the first run asks for
 * the address and keeps it in the app's own data folder. CONVERGE_URL, when set, wins (development and tests).
 */
type Saved = { serverUrl?: string }

const FILE = 'converge.json'

/** Normalises what a person typed into a server origin, or explains what is wrong with it. */
export function parseServer(input: string): { url: URL } | { error: string } {
  let text = input.trim()
  if (!text) return { error: 'Type the address of your Converge server.' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { error: 'That is not a web address.' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'The address must start with https:// or http://.' }
  if (url.username || url.password) return { error: 'Leave the user name and password out of the address.' }
  // Plain HTTP only for this machine or a private network; anything public must use HTTPS.
  const host = url.hostname
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /^(10|192\.168)\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local')
  if (url.protocol === 'http:' && !local) return { error: 'Use https:// for a server on the internet.' }
  return { url: new URL(url.origin) }
}

export async function loadServer(dataDir: string): Promise<URL | null> {
  if (process.env.CONVERGE_URL) return new URL(process.env.CONVERGE_URL)
  try {
    const saved = JSON.parse(await readFile(path.join(dataDir, FILE), 'utf8')) as Saved
    if (!saved.serverUrl) return null
    const parsed = parseServer(saved.serverUrl)
    return 'url' in parsed ? parsed.url : null
  } catch {
    return null
  }
}

export async function saveServer(dataDir: string, url: URL): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, FILE), JSON.stringify({ serverUrl: url.origin } satisfies Saved, null, 2))
}

/** Checks that a Converge server answers at this address, so a typo is caught before the app tries to load it. */
export async function probeServer(url: URL): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(new URL('/api/actuator/health', url), { signal: AbortSignal.timeout(8000) })
    const body = (await response.json().catch(() => null)) as { status?: unknown } | null
    if (body && typeof body.status === 'string') return { ok: true }
    return { ok: false, error: `Something answered at ${url.host}, but it is not a Converge server.` }
  } catch {
    return { ok: false, error: `No Converge server answered at ${url.host}. Check the address and that the server is running.` }
  }
}
