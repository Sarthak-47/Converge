// Visual check of the web app without the backend: serves the built app (apps/web/dist) with `vite preview` and
// answers the API from the fixtures below, then screenshots every main surface in light and dark, desktop and phone.
// Realtime sockets are refused, so the editor shows "Connecting…" and no text; everything that loads over REST
// (workspaces, files, chat, sessions, lanes, approvals, memory, the agent budget) renders with realistic data.
//
//   npm run build -w @converge/web
//   PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright node tests/visual/capture.mjs [outDir]
//
// Screenshots go to .impeccable/review/ by default (gitignored). Use them to review a design change before CI.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { api, W } from './fixtures.mjs'

const out = process.argv[2] ?? '.impeccable/review'
mkdirSync(out, { recursive: true })
const PORT = 4173
const BASE = `http://127.0.0.1:${PORT}`

/** Starts vite preview as a direct child (no shell), so closing it really ends the server. */
async function startServer() {
  // Run from the repository root; npm workspaces hoist vite there.
  const vite = join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js')
  const server = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: 'apps/web' })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite preview did not start (is port 4173 free?)')), 60_000)
    server.stdout.on('data', (d) => { if (String(d).includes(String(PORT))) { clearTimeout(timer); resolve() } })
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`vite preview exited (${code})`)) })
  })
  return server
}

async function withFixtures(context, signedIn = true) {
  await context.route('**/api/**', (route) => {
    if (!signedIn) return route.fulfill({ status: 401, json: { detail: 'Not signed in' } })
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET') return route.fulfill({ status: 200, json: {} })
    const hit = api.find(([pattern]) => pattern.test(url.pathname))
    return route.fulfill({ status: 200, json: hit ? hit[1] : [] })
  })
  await context.route('**/ws/**', (route) => route.abort())
}

const settle = (page, ms = 900) => page.waitForTimeout(ms)

const server = await startServer()
const browser = await chromium.launch()
const shots = []
try {
  for (const scheme of ['light', 'dark']) {
    for (const [device, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
      const shot = async (page, name, fullPage = false) => {
        const path = `${out}/${name}-${device}-${scheme}.png`
        await page.screenshot({ path, fullPage })
        shots.push(path)
      }

      const signedOut = await browser.newContext({ viewport, colorScheme: scheme })
      await withFixtures(signedOut, false)
      const login = await signedOut.newPage()
      await login.goto(`${BASE}/login`)
      await settle(login, 2400)
      await shot(login, 'login', true)
      await signedOut.close()

      const context = await browser.newContext({ viewport, colorScheme: scheme })
      await withFixtures(context)
      const page = await context.newPage()
      await page.goto(`${BASE}/`)
      await settle(page)
      await shot(page, 'workspaces', true)

      await page.goto(`${BASE}/w/${W}`)
      await settle(page, 1500)
      await page.getByText('checkout.ts').first().click()
      await settle(page, 1200)
      await shot(page, 'ide')

      await page.getByRole('tab', { name: 'Sessions' }).click()
      await settle(page)
      await shot(page, 'sessions')
      await page.getByRole('button', { name: /Harden checkout/ }).first().click()
      await settle(page, 1200)
      await shot(page, 'session')
      for (const [name, at] of [['session-lane-a', 0.42], ['session-lane-b', 1]]) {
        await page.locator('.session-scroll').evaluate((el, f) => el.scrollTo(0, el.scrollHeight * f), at)
        await settle(page, 400)
        await shot(page, name)
      }
      await page.getByRole('tab', { name: 'Memory' }).click()
      await settle(page)
      await shot(page, 'memory')
      await context.close()
    }
  }
} finally {
  await browser.close()
  server.kill()
}
console.log(shots.join('\n'))
