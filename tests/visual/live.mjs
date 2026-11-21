// Visual check against the real stack (start it with the fake model, see the README): sets up two people sharing a
// workspace, opens the editor in two browsers so presence and cursor flags are live, chats, and runs scripted agent
// turns in a session (one asks for an approval), then screenshots what Asha sees in light and dark.
//
//   COMPOSE_PROFILES=fake-model AGENT_MODEL_URL=http://fake-model:9100 docker compose up -d --build
//   PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright node tests/visual/live.mjs [outDir]
//
// Accounts are throwaway test users on the local stack (example.test addresses).
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'
import { BASE, person, sleep } from '../load/stack.mjs'

const out = process.argv[2] ?? '.impeccable/review'
mkdirSync(out, { recursive: true })
const tool = (name, input) => `@tool ${name} ${JSON.stringify(input)}`
const CODE = `import { applyDiscount } from './pricing'

export async function checkout(cart: Cart) {
  const subtotal = cart.items.reduce((s, i) => s + i.price * i.qty, 0)
  const discounted = applyDiscount(subtotal, cart.coupon)
  const tax = discounted * cart.taxRate
  return { subtotal, discounted, tax, total: discounted + tax }
}
`

// People and a shared workspace, set up through the API.
const asha = await person('Asha Rao')
const ben = await person('Ben Okafor')
const api = (who, method, path, body) => who.session.request(method, `/api/v1${path}`, body)
const workspace = await api(asha, 'POST', '/workspaces', { name: 'Checkout service' })
const W = workspace.id
const src = await api(asha, 'POST', '/files', { workspaceId: W, parentId: null, name: 'src', kind: 'FOLDER' })
const file = await api(asha, 'POST', '/files', { workspaceId: W, parentId: src.id, name: 'checkout.ts', kind: 'FILE' })
await api(asha, 'POST', '/files', { workspaceId: W, parentId: src.id, name: 'cart.ts', kind: 'FILE' })
await api(asha, 'POST', '/files', { workspaceId: W, parentId: null, name: 'README.md', kind: 'FILE' })
const content = await api(asha, 'GET', `/files/${file.id}/content`)
await api(asha, 'PUT', `/files/${file.id}/content`, { text: CODE, baseVersion: content.version })
await api(asha, 'POST', `/workspaces/${W}/members`, { email: ben.email, role: 'EDITOR' })
await api(asha, 'PUT', '/me/provider-keys/anthropic', { apiKey: 'sk-ant-test-visual-asha-0000001' })
await api(ben, 'PUT', '/me/provider-keys/anthropic', { apiKey: 'sk-ant-test-visual-ben-00000001' })

// A session with two lanes: Asha's agent edits, Ben's agent asks to run the tests (an approval).
const session = await api(asha, 'POST', `/workspaces/${W}/sessions`, { task: 'Harden checkout: round tax per line' })
await api(ben, 'POST', `/sessions/${session.id}/join`, { mode: 'LANE' })
await api(asha, 'POST', `/sessions/${session.id}/steps`, { titles: ['Round tax per line, not per order', 'Cover the rounding edge cases in tests', 'Open the pull request'] })
await api(asha, 'POST', `/workspaces/${W}/agent/turns`, {
  sessionId: session.id,
  prompt: ['Round tax to the cent per line.', tool('read_file', { path: 'src/checkout.ts' }),
    tool('edit_file', { path: 'src/checkout.ts', old_string: 'const tax = discounted * cart.taxRate', new_string: 'const tax = Math.round(discounted * cart.taxRate * 100) / 100' }),
    '@say Tax now rounds to the cent; totals match the invoice service.'].join('\n'),
})
await sleep(4000)
await api(ben, 'POST', `/workspaces/${W}/agent/turns`, {
  sessionId: session.id,
  prompt: ['Write a test for 0.005 and run it.', tool('create_file', { path: 'tests/checkout.test.ts', content: "import test from 'node:test'\n" }),
    tool('run_command', { command: 'node --test tests/checkout.test.ts' })].join('\n'),
})
await sleep(4000)

async function browserFor(who, scheme) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
  const host = new URL(BASE).hostname
  await context.addCookies([...who.session.cookies].map(([name, value]) => ({ name, value, domain: host, path: '/' })))
  const page = await context.newPage()
  await page.goto(`${BASE}/w/${W}`)
  await page.locator('.tree-name', { hasText: 'checkout.ts' }).click()
  await page.locator('.monaco-editor .view-lines').waitFor()
  return { context, page }
}

const browser = await chromium.launch()
try {
  for (const scheme of ['light', 'dark']) {
    const a = await browserFor(asha, scheme)
    const b = await browserFor(ben, scheme)
    // Ben's cursor sits in the line being discussed, so Asha sees his flag.
    await b.page.locator('.monaco-editor .view-line', { hasText: 'const discounted' }).click()
    await b.page.keyboard.press('End')
    if (scheme === 'light') {
      await b.page.getByLabel('Message').fill('Tests pass on my side. Open the PR?')
      await b.page.getByLabel('Message').press('Enter')
      await a.page.getByLabel('Message').fill('After the last plan step.')
      await a.page.getByLabel('Message').press('Enter')
    }
    await sleep(1500)
    await a.page.screenshot({ path: `${out}/live-ide-${scheme}.png` })
    await a.page.getByRole('tab', { name: 'Sessions' }).click()
    await a.page.getByRole('button', { name: /Harden checkout/ }).first().click()
    await sleep(1500)
    await a.page.screenshot({ path: `${out}/live-session-${scheme}.png` })
    await a.page.locator('.session-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await sleep(600)
    await a.page.screenshot({ path: `${out}/live-lanes-${scheme}.png` })
    await a.context.close()
    await b.context.close()
  }
} finally {
  await browser.close()
}
console.log(`captured live screens for workspace ${W}`)
