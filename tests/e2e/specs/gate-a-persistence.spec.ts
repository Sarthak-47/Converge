import { expect, test } from '@playwright/test'
import {
  createFile,
  createWorkspace,
  editorText,
  openFile,
  register,
  restart,
  signIn,
  typeAtEnd,
  uniqueEmail,
  waitForStack,
  waitUntilSaved,
} from './helpers.ts'

/** Gate A (design §19.2): a restart must leave the workspace usable and lose no saved work. */
test('saved work survives restarting the API and the collaboration service', async ({ page }) => {
  const email = uniqueEmail('gate-a')
  await register(page, email)
  await createWorkspace(page, 'Persistence check')
  await createFile(page, 'hello.ts')

  await typeAtEnd(page, 'export const greeting = 42')
  await waitUntilSaved(page)

  restart('collab')
  restart('api')
  await waitForStack(page)

  // Sessions are held in memory for now, so a restart signs people out; the data must still be there.
  await signIn(page, email)
  await page.getByRole('link', { name: 'Persistence check' }).click()
  await openFile(page, 'hello.ts')
  await expect.poll(() => editorText(page), { timeout: 30_000 }).toContain('export const greeting = 42')
})
