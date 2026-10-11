import { expect, test } from '@playwright/test'
import {
  createFile,
  createWorkspace,
  editorText,
  openFile,
  register,
  secondBrowser,
  typeAtEnd,
  typeAtStart,
  uniqueEmail,
  waitUntilSaved,
} from './helpers.ts'

/**
 * Gate D (design §19.2): restoring a version while someone is typing must lose nothing. Ben types while
 * offline, so his edit is guaranteed to be concurrent with the restore; it must survive the merge, while the
 * text added after the checkpoint is reverted. The replaced text is kept as a new version.
 */
test('restoring a version keeps edits made concurrently with the restore', async ({ browser, page }) => {
  const email = uniqueEmail('gate-d')
  await register(page, email)
  await createWorkspace(page, 'Restore check')
  await createFile(page, 'chapter.md')
  await typeAtEnd(page, 'chapter one')
  await waitUntilSaved(page)

  page.once('dialog', (dialog) => void dialog.accept('first draft'))
  await page.getByRole('button', { name: 'Checkpoint' }).click()
  await expect(page.locator('.notice-banner')).toContainText('Saved checkpoint v1')

  await typeAtEnd(page, ' rewritten later')
  await waitUntilSaved(page)

  const ben = await secondBrowser(browser, email, page.url())
  await openFile(ben.page, 'chapter.md')
  await expect.poll(() => editorText(ben.page)).toContain('rewritten later')

  // Ben edits a part of the text that the restore does not change, while he is offline.
  await ben.network.goOffline()
  await expect(ben.page.locator('.statusbar [data-sync]')).toHaveAttribute('data-sync', 'offline', { timeout: 30_000 })
  await typeAtStart(ben.page, 'BEN-OFFLINE ')

  await page.getByRole('button', { name: 'History' }).click()
  await page.locator('.version', { hasText: 'first draft' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Restore this version' }).click()
  await expect(page.locator('.notice-banner')).toContainText('Restored version 1')
  await expect.poll(() => editorText(page), { timeout: 20_000 }).not.toContain('rewritten later')

  await ben.network.goOnline()
  await waitUntilSaved(ben.page)
  await expect.poll(async () => (await editorText(page)) === (await editorText(ben.page)), { timeout: 30_000 }).toBe(true)
  const merged = await editorText(page)
  expect(merged).toContain('BEN-OFFLINE')
  expect(merged).toContain('chapter one')
  expect(merged).not.toContain('rewritten later')

  // The text the restore replaced is itself a version, so the restore can be undone.
  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.locator('.version').first()).toContainText('Before restoring version 1')
  await ben.context.close()
})
