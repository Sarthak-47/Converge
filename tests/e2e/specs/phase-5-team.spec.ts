import { expect, test, type Browser } from '@playwright/test'
import { createFile, createWorkspace, editorText, openFile, register, typeAtEnd, uniqueEmail, waitUntilSaved } from './helpers.ts'

async function newPerson(browser: Browser, name: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const email = uniqueEmail(name.toLowerCase())
  await register(page, email, name)
  return { context, page, email }
}

/**
 * Team features (design §19.1, Phase 5): roles are enforced for open sessions, and changes to someone's
 * access reach their browser without a reload (FR-18).
 */
test('a viewer can read but not edit, and role changes apply live', async ({ browser, page }) => {
  await register(page, uniqueEmail('owner'), 'Owner')
  await createWorkspace(page, 'Team check')
  await createFile(page, 'plan.md')
  await typeAtEnd(page, 'owner wrote this')
  await waitUntilSaved(page)
  const workspaceUrl = page.url()

  const ben = await newPerson(browser, 'Ben')
  await page.getByRole('button', { name: 'Members' }).click()
  await page.getByLabel('Email to invite').fill(ben.email)
  await page.getByLabel('Role for the invitation').selectOption('VIEWER')
  await page.getByRole('button', { name: 'Invite' }).click()
  await expect(page.locator('.dialog .notice')).toContainText('Ben was added')

  await ben.page.goto(workspaceUrl)
  await expect(ben.page.locator('.role-badge')).toHaveText('viewer')
  await openFile(ben.page, 'plan.md')
  await expect.poll(() => editorText(ben.page)).toContain('owner wrote this')
  await typeAtEnd(ben.page, ' viewer typing')
  await page.waitForTimeout(1500)
  expect(await editorText(page)).not.toContain('viewer typing')

  // Promote Ben while his tab is open: his role and editor update without a reload.
  await page.getByLabel('Role for Ben').selectOption('EDITOR')
  await expect(page.locator('.dialog .notice')).toContainText('Ben is now editor')
  await expect(ben.page.locator('.role-badge')).toHaveText('editor', { timeout: 15_000 })
  await ben.page.reload()
  await openFile(ben.page, 'plan.md')
  await typeAtEnd(ben.page, ' ben edited')
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain('ben edited')

  // Remove Ben: his open session loses access.
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator('.dialog .notice')).toContainText('Ben was removed')
  await expect(ben.page.locator('main .error')).toContainText('no longer have access', { timeout: 20_000 })
  await ben.context.close()
})
