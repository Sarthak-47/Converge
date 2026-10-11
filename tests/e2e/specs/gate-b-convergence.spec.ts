import { expect, test } from '@playwright/test'
import {
  createFile,
  createWorkspace,
  editorText,
  openFile,
  register,
  restart,
  secondBrowser,
  typeAtEnd,
  typeAtStart,
  uniqueEmail,
  waitUntilSaved,
} from './helpers.ts'

/**
 * Gate B (design §19.2): concurrent editing must converge in real browsers, including after one of them
 * goes offline, and across a restart of the collaboration service. Two independent browsers (separate
 * cookies and sockets) edit the same file at the same time.
 */
test('two browsers editing one file converge, through offline work and a server restart', async ({ browser, page }) => {
  const email = uniqueEmail('gate-b')
  await register(page, email)
  await createWorkspace(page, 'Convergence check')
  await createFile(page, 'shared.md')
  const workspaceUrl = page.url()

  const ben = await secondBrowser(browser, email, workspaceUrl)
  await openFile(ben.page, 'shared.md')

  await typeAtEnd(page, 'middle ')
  await expect.poll(() => editorText(ben.page)).toContain('middle')

  // Both type at once, at opposite ends. The naive relay would keep only one of these
  // (see NaiveBroadcastTest). Typing at the very same position at the same instant interleaves
  // characters, which is correct CRDT behaviour but makes a poor assertion.
  await Promise.all([typeAtEnd(page, 'alpha from asha '), typeAtStart(ben.page, 'beta from ben ')])
  await expect.poll(async () => (await editorText(page)) === (await editorText(ben.page)), { timeout: 20_000 }).toBe(true)
  const merged = await editorText(page)
  expect(merged).toContain('alpha from asha')
  expect(merged).toContain('beta from ben')

  // Ben loses the network and keeps typing; Asha keeps typing too. Nothing is lost on reconnect.
  await ben.network.goOffline()
  await expect(ben.page.locator('.statusbar [data-sync]')).toHaveAttribute('data-sync', 'offline', { timeout: 30_000 })
  await typeAtEnd(ben.page, 'written offline ')
  await typeAtEnd(page, 'written online ')
  await ben.network.goOnline()
  await waitUntilSaved(ben.page)
  await expect.poll(async () => (await editorText(page)) === (await editorText(ben.page)), { timeout: 30_000 }).toBe(true)
  expect(await editorText(page)).toContain('written offline')
  expect(await editorText(page)).toContain('written online')

  // Restart the collaboration service: both clients reconnect and keep converging.
  restart('collab')
  await waitUntilSaved(page)
  await waitUntilSaved(ben.page)
  await typeAtEnd(page, 'after restart')
  await expect.poll(() => editorText(ben.page), { timeout: 30_000 }).toContain('after restart')
  await ben.context.close()
})

test('a change written through the API merges into a file someone is editing', async ({ page }) => {
  await register(page, uniqueEmail('external'))
  await createWorkspace(page, 'External change check')
  await createFile(page, 'notes.txt')
  await typeAtEnd(page, 'line one')
  await waitUntilSaved(page)

  const fileId = await page.evaluate(async () => {
    const tree = await (await fetch(location.pathname.replace('/w/', '/api/v1/workspaces/') + '/tree')).json()
    return tree.find((f: { name: string }) => f.name === 'notes.txt').id as string
  })
  const csrf = (await page.context().cookies()).find((c) => c.name === 'XSRF-TOKEN')?.value ?? ''
  const response = await page.request.put(`/api/v1/files/${fileId}/content`, {
    data: { text: 'LINE ONE' },
    headers: { 'X-XSRF-TOKEN': csrf },
  })
  expect(response.status()).toBe(200)

  await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain('LINE ONE')
})
