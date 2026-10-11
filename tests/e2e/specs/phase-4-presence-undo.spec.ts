import { expect, test } from '@playwright/test'
import {
  createFile,
  createWorkspace,
  editorText,
  openFile,
  register,
  secondBrowser,
  typeAtEnd,
  uniqueEmail,
  waitUntilSaved,
} from './helpers.ts'

/**
 * Presence and per-user undo (design §8.6, §8.8). Monaco's built-in undo cannot tell whose edit is whose,
 * so Ctrl+Z would revert a collaborator's typing; the Yjs UndoManager reverts only your own.
 */
test('undo reverts only your own edits, and collaborators are visible', async ({ browser, page }) => {
  const email = uniqueEmail('phase-4')
  await register(page, email, 'Asha Rao')
  await createWorkspace(page, 'Presence check')
  await createFile(page, 'undo.txt')
  const ben = await secondBrowser(browser, email, page.url())
  await openFile(ben.page, 'undo.txt')

  await expect(page.locator('.editor-peers')).toContainText('Asha Rao')
  await expect(page.locator('.presence .avatar')).toHaveCount(1)

  await typeAtEnd(page, 'mine ')
  await waitUntilSaved(page)
  await expect.poll(() => editorText(ben.page)).toContain('mine')
  await typeAtEnd(ben.page, 'theirs')
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain('theirs')

  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+z')

  await expect.poll(() => editorText(page), { timeout: 20_000 }).not.toContain('mine')
  expect(await editorText(page)).toContain('theirs')
  await expect.poll(() => editorText(ben.page), { timeout: 20_000 }).not.toContain('mine')
  expect(await editorText(ben.page)).toContain('theirs')

  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(() => editorText(ben.page), { timeout: 20_000 }).toContain('mine')
  await ben.context.close()
})
