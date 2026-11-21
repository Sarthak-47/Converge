import { expect, test } from '@playwright/test'
import {
  createFile,
  createWorkspace,
  editorText,
  openFile,
  register,
  restart,
  typeAtEnd,
  uniqueEmail,
  waitForStack,
  waitUntilSaved,
} from './helpers.ts'

/** Gate A (design §19.2): a restart must leave the workspace usable and lose no saved work. */
test('saved work and the sign-in survive restarting the API and the collaboration service', async ({ page }) => {
  const email = uniqueEmail('gate-a')
  await register(page, email)
  await createWorkspace(page, 'Persistence check')
  await createFile(page, 'hello.ts')

  await typeAtEnd(page, 'export const greeting = 42')
  await waitUntilSaved(page)

  restart('collab')
  restart('api')
  await waitForStack(page)

  // Sessions live in PostgreSQL, so the restart signs no one out; the data must still be there too.
  await page.goto('/')
  await page.getByRole('link', { name: 'Persistence check' }).click()
  await openFile(page, 'hello.ts')
  await expect.poll(() => editorText(page), { timeout: 30_000 }).toContain('export const greeting = 42')
})
