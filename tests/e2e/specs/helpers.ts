import { execSync } from 'node:child_process'
import { expect, type Browser, type Page } from '@playwright/test'

export const password = 'correct horse battery'

export function uniqueEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`
}

export async function register(page: Page, email: string, name = 'Tester') {
  await page.goto('/register')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Display name').fill(name)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible()
}

export async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible()
}

export async function createWorkspace(page: Page, name: string) {
  await page.getByPlaceholder('New workspace name').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('.workspace-name')).toHaveText(name)
}

export async function createFile(page: Page, name: string) {
  await page.getByTitle('New file').click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Name').press('Enter')
  await expect(page.locator('.statusbar')).toContainText(name)
}

export async function openFile(page: Page, name: string) {
  await page.locator('.tree-name', { hasText: name }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
}

/** A second, independent browser (own cookies and sockets) signed in as the same person. */
export async function secondBrowser(browser: Browser, email: string, workspaceUrl: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, email)
  await page.goto(workspaceUrl)
  return { context, page }
}

/** Types at the end of the document. Uses plain words so Monaco's auto-closing never alters the text. */
export async function typeAtEnd(page: Page, text: string) {
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

export async function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.monaco-editor .view-lines .view-line')]
    return lines
      .map((line) => ({ top: parseFloat((line as HTMLElement).style.top), text: line.textContent ?? '' }))
      .sort((a, b) => a.top - b.top)
      .map((l) => l.text.replace(/ /g, ' '))
      .join('\n')
  })
}

export async function waitUntilSaved(page: Page) {
  await expect(page.locator('.statusbar [data-sync]')).toHaveAttribute('data-sync', 'saved', { timeout: 30_000 })
}

export function restart(service: 'api' | 'collab') {
  execSync(`docker compose restart ${service}`, { stdio: 'inherit', cwd: '../..' })
}

export async function waitForStack(page: Page) {
  await expect
    .poll(async () => (await page.request.get('/api/actuator/health')).status(), { timeout: 120_000, intervals: [1000] })
    .toBe(200)
}
