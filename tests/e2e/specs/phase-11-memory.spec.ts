import { expect, test, type Browser, type Page } from '@playwright/test'
import { answer, createFile, createWorkspace, editorText, openFile, register, typeAtEnd, typeAtStart, uniqueEmail, waitUntilSaved } from './helpers.ts'

/**
 * Phase 11 exit (design §13.10, §13.11): a note follows its code through edits and is flagged when that code is
 * rewritten; agents pin notes too and stay out of ranges people hold.
 */
const tool = (name: string, input: object) => `@tool ${name} ${JSON.stringify(input)}`

/** The text under a decoration; Monaco splits decorations across token spans. */
const under = async (page: Page, selector: string) =>
  (await page.locator(selector).allTextContents()).join('').replace(/ /g, ' ')

async function person(browser: Browser, name: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const email = uniqueEmail(name.toLowerCase())
  await register(page, email, name)
  return { page, email, close: () => context.close() }
}

async function selectFirstLine(page: Page) {
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Shift+End')
}

test('a note follows its code through edits and is flagged when that code is rewritten', async ({ browser, page }) => {
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Memory check')
  await createFile(page, 'retry.ts')
  await typeAtEnd(page, 'export const retryLimit = 3')
  await page.keyboard.press('Enter')
  await page.keyboard.type('export const other = 1')
  await waitUntilSaved(page)
  const workspaceUrl = page.url()
  const ben = await person(browser, 'Ben')
  await page.getByRole('button', { name: 'Members' }).click()
  await page.getByLabel('Email to invite').fill(ben.email)
  await page.getByLabel('Role for the invitation').selectOption('EDITOR')
  await page.getByRole('button', { name: 'Invite' }).click()
  await expect(page.locator('.dialog .notice')).toContainText('was added')
  await page.reload()
  await openFile(page, 'retry.ts')

  await selectFirstLine(page)
  await page.getByRole('button', { name: 'Note', exact: true }).click()
  await answer(page, 'gotcha: Upstream allows three calls per minute')
  await expect(page.getByLabel('Notes on this file')).toContainText('gotcha: Upstream allows three calls per minute')
  await expect.poll(() => under(page, '.memory-range')).toBe('export const retryLimit = 3')

  // Ben types above it: the note follows its code.
  await ben.page.goto(workspaceUrl)
  await openFile(ben.page, 'retry.ts')
  await typeAtStart(ben.page, '// tuned ')
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain('// tuned export const retryLimit = 3')
  await expect.poll(() => under(page, '.memory-range')).toBe('export const retryLimit = 3')
  await page.getByRole('tab', { name: 'Memory' }).click()
  await expect(page.getByLabel(/Note on retry.ts/)).not.toContainText('stale')

  // Ben rewrites that code: the collaboration service flags the note once it stores the document.
  await selectFirstLine(ben.page)
  await ben.page.keyboard.type('export const retryLimit = loadLimitFromConfig()')
  await waitUntilSaved(ben.page)
  const note = page.getByLabel(/Note on retry.ts/)
  await expect(note).toContainText('stale', { timeout: 30_000 })
  await expect(note).toContainText('the code was deleted')
  await expect(page.getByLabel('Notes on this file')).toContainText('stale: its code changed')

  // Rewriting the note keeps it; retiring it removes it from the list.
  await note.getByRole('button', { name: 'Edit' }).click()
  await answer(page, 'The limit now comes from config')
  await expect(page.getByLabel(/Note on retry.ts: The limit now comes from config/)).toBeVisible()
  await page.getByLabel(/Note on retry.ts/).getByRole('button', { name: 'Retire' }).click()
  await expect(page.getByLabel(/Note on retry.ts/)).toHaveCount(0)
  await ben.close()
})

test('agents pin notes and stay out of ranges people hold', async ({ page }) => {
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Hold check')
  await createFile(page, 'pay.ts')
  await typeAtEnd(page, 'const gateway = legacyGateway')
  await page.keyboard.press('Enter')
  await page.keyboard.type('const currency = usd')
  await waitUntilSaved(page)

  await selectFirstLine(page)
  await page.getByRole('button', { name: 'Hold', exact: true }).click()
  await answer(page, 'migrating the gateway')
  await expect(page.getByLabel('Notes on this file')).toContainText('Held by Asha: migrating the gateway')

  await page.getByRole('tab', { name: 'Sessions' }).click()
  await page.getByLabel('New session: what should get done?').fill('Tidy payments')
  await page.getByRole('button', { name: 'Start session' }).click()
  await page.getByLabel('Your Anthropic API key').fill('sk-ant-test-e2e-asha-memory0001')
  await page.getByRole('button', { name: 'Save key' }).click()
  await page.getByLabel(/Prompt your agent/).fill([
    tool('edit_file', { path: 'pay.ts', old_string: 'legacyGateway', new_string: 'newGateway' }),
    tool('write_memory', { path: 'pay.ts', anchor_text: 'const currency = usd', note: 'Prices are stored in cents', kind: 'CONVENTION' }),
  ].join('\n'))
  await page.getByRole('button', { name: 'Send to agent' }).click()
  const lane = page.getByLabel("Asha's lane")
  await expect(lane.locator('.agent-status').last()).toHaveText('Done', { timeout: 30_000 })
  await expect(lane).toContainText('held by Asha (migrating the gateway)')
  await expect(lane.locator('.agent-tool.ok', { hasText: 'pinned a note to pay.ts' })).toBeVisible()
  expect(await editorText(page)).toContain('legacyGateway')

  await page.getByRole('tab', { name: 'Memory' }).click()
  await expect(page.getByLabel(/Note on pay.ts: Prices are stored in cents/)).toContainText("Asha's agent")
  await expect(page.locator('.memory-panel')).toContainText('migrating the gateway')
})
