import { execSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

/**
 * Gate A (design §19.2): a restart must leave the workspace usable. Sign up, create a workspace and a file,
 * type into Monaco, save, restart the API container, sign back in and find the text still there.
 */

const password = 'correct horse battery'

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible()
}

async function waitForApi(page: Page) {
  await expect
    .poll(async () => (await page.request.get('/api/actuator/health')).status(), { timeout: 90_000, intervals: [1000] })
    .toBe(200)
}

test('saved work survives an API restart', async ({ page }) => {
  const email = `gate-a-${Date.now()}@example.test`

  await page.goto('/register')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Display name').fill('Gate A')
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible()

  await page.getByPlaceholder('New workspace name').fill('Persistence check')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('.workspace-name')).toHaveText('Persistence check')

  await page.getByTitle('New file').click()
  await page.getByLabel('Name').fill('hello.ts')
  await page.getByLabel('Name').press('Enter')
  await expect(page.locator('.statusbar')).toContainText('hello.ts')

  const editor = page.locator('.monaco-editor').first()
  await editor.click()
  await page.keyboard.type('export const greeting = "survives restarts"')
  await expect(page.locator('.statusbar')).toContainText('Unsaved changes')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.statusbar')).toContainText('Saved')

  execSync('docker compose restart api', { stdio: 'inherit', cwd: '../..' })
  await waitForApi(page)

  // Sessions are in memory for now, so a restart signs everyone out; the data must still be there.
  await signIn(page, email)
  await page.getByRole('link', { name: 'Persistence check' }).click()
  await page.locator('.tree-name', { hasText: 'hello.ts' }).click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('survives restarts')
})

test('a stale save is caught instead of overwriting newer text', async ({ browser }) => {
  const email = `conflict-${Date.now()}@example.test`
  // Both tabs share one context (and so one session), like two tabs of the same browser.
  const context = await browser.newContext()
  const first = await context.newPage()
  await first.goto('/register')
  await first.getByLabel('Email').fill(email)
  await first.getByLabel('Display name').fill('Conflict')
  await first.getByLabel('Password').fill(password)
  await first.getByRole('button', { name: 'Create account' }).click()
  await first.getByPlaceholder('New workspace name').fill('Conflict check')
  await first.getByRole('button', { name: 'Create', exact: true }).click()
  await first.getByTitle('New file').click()
  await first.getByLabel('Name').fill('notes.md')
  await first.getByLabel('Name').press('Enter')
  const url = first.url()

  // A second tab of the same user opens the same file before the first one saves.
  const second = await context.newPage()
  await second.goto(url)
  await second.locator('.tree-name', { hasText: 'notes.md' }).click()
  await expect(second.locator('.monaco-editor')).toBeVisible()

  await first.locator('.monaco-editor').first().click()
  await first.keyboard.type('first tab wins')
  await first.keyboard.press('ControlOrMeta+s')
  await expect(first.locator('.statusbar')).toContainText('Saved')

  await second.locator('.monaco-editor').first().click()
  await second.keyboard.type('second tab is stale')
  await second.keyboard.press('ControlOrMeta+s')
  // Target the conflict banner itself: Monaco also renders role=alert regions for screen readers.
  await expect(second.locator('.banner.warning')).toContainText('saved by someone else')
})
