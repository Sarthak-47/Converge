import { expect, test, type Browser } from '@playwright/test'
import { answer, createFile, createWorkspace, editorText, openFile, register, typeAtEnd, uniqueEmail, waitUntilSaved } from './helpers.ts'

async function newPerson(browser: Browser, name: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const email = uniqueEmail(name.toLowerCase())
  await register(page, email, name)
  return { context, page, email }
}

/**
 * Workspace administration (FR-02, FR-04, FR-11): owners rename and archive workspaces, and archiving makes
 * the workspace read-only for everyone at once; files move between folders; any two versions can be compared.
 */
test('an owner renames and archives a workspace, and everyone sees it read-only at once', async ({ browser, page }) => {
  await register(page, uniqueEmail('owner'), 'Owner')
  await createWorkspace(page, 'Admin check')
  await createFile(page, 'plan.md')
  await typeAtEnd(page, 'first plan')
  await waitUntilSaved(page)
  const workspaceUrl = page.url()

  const ben = await newPerson(browser, 'Ben')
  await page.getByRole('button', { name: 'Members' }).click()
  await page.getByLabel('Email to invite').fill(ben.email)
  await page.getByLabel('Role for the invitation').selectOption('EDITOR')
  await page.getByRole('button', { name: 'Invite' }).click()
  await expect(page.locator('.dialog .notice')).toContainText('Ben was added')
  await page.keyboard.press('Escape')
  await ben.page.goto(workspaceUrl)
  await openFile(ben.page, 'plan.md')
  await expect(ben.page.getByTitle('New file')).toBeVisible()

  // Rename: the new name reaches Ben's open tab too.
  await page.getByRole('button', { name: 'Workspace settings' }).click()
  await page.getByLabel('Workspace name').fill('Admin check (renamed)')
  await page.getByRole('button', { name: 'Rename' }).click()
  await expect(page.locator('.workspace-name')).toHaveText('Admin check (renamed)')
  await expect(ben.page.locator('.workspace-name')).toHaveText('Admin check (renamed)', { timeout: 15_000 })

  // Archive: read-only for everyone, without a reload.
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.archived-banner')).toContainText('archived')
  await expect(ben.page.locator('.archived-banner')).toContainText('archived', { timeout: 15_000 })
  await expect(ben.page.getByTitle('New file')).toHaveCount(0)
  await typeAtEnd(ben.page, ' ben tried')
  await page.waitForTimeout(1500)
  expect(await editorText(page)).not.toContain('ben tried')

  // Unarchive from the banner: editing works again.
  await page.getByRole('button', { name: 'Unarchive' }).click()
  await expect(page.locator('.archived-banner')).toHaveCount(0)
  await expect(ben.page.locator('.archived-banner')).toHaveCount(0, { timeout: 15_000 })
  await ben.page.reload()
  await openFile(ben.page, 'plan.md')
  await typeAtEnd(ben.page, ' ben is back')
  await expect.poll(() => editorText(page), { timeout: 15_000 }).toContain('ben is back')
  await ben.context.close()
})

test('a file moves into a folder, and two saved versions can be compared', async ({ page }) => {
  await register(page, uniqueEmail('mover'), 'Mover')
  await createWorkspace(page, 'Move check')
  await page.getByTitle('New folder').click()
  await page.getByLabel('Name', { exact: true }).fill('src')
  await page.getByLabel('Name', { exact: true }).press('Enter')
  await createFile(page, 'notes.md')
  await expect(page.locator('.tree-row[title="notes.md"]')).toBeVisible()

  await page.locator('.tree-row[title="notes.md"]').hover()
  await page.getByRole('button', { name: 'Move notes.md' }).click()
  await answer(page, 'src')
  await expect(page.locator('.tree-row[title="src/notes.md"]')).toBeVisible()
  await expect(page.locator('.tree-row[title="notes.md"]')).toHaveCount(0)

  await openFile(page, 'notes.md')
  await typeAtEnd(page, 'draft one')
  await waitUntilSaved(page)
  await page.getByRole('button', { name: 'Checkpoint' }).click()
  await answer(page, 'one')
  await typeAtEnd(page, ' then two')
  await waitUntilSaved(page)
  await page.getByRole('button', { name: 'Checkpoint' }).click()
  await answer(page, 'two')

  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.locator('.version').first()).toContainText('two')
  // Version numbers depend on autosaves, so pick the checkpoint by its label.
  const one = await page.locator('select[aria-label="Compare with"] option', { hasText: '(one)' }).getAttribute('value')
  await page.getByLabel('Compare with').selectOption(one!)
  await expect(page.locator('.history-diff')).toContainText('Both sides are saved versions')
})
