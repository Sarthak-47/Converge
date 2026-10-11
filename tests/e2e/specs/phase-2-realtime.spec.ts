import { expect, test } from '@playwright/test'

/**
 * Phase 2 exit criterion (design §19.1): two browsers receive realtime events. Until invitations exist
 * (Phase 5) both tabs belong to the same user, which still exercises separate sockets and subscriptions.
 */
test('chat and file-tree changes reach another open tab live', async ({ browser }) => {
  const context = await browser.newContext()
  const first = await context.newPage()
  await first.goto('/register')
  await first.getByLabel('Email').fill(`realtime-${Date.now()}@example.test`)
  await first.getByLabel('Display name').fill('Realtime')
  await first.getByLabel('Password').fill('correct horse battery')
  await first.getByRole('button', { name: 'Create account' }).click()
  await first.getByPlaceholder('New workspace name').fill('Live workspace')
  await first.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(first.locator('.connection')).toHaveText('Live')

  const second = await context.newPage()
  await second.goto(first.url())
  await expect(second.locator('.connection')).toHaveText('Live')

  await first.getByLabel('Message').fill('hello from the first tab')
  await first.getByLabel('Message').press('Enter')
  await expect(second.locator('.chat-messages')).toContainText('hello from the first tab')

  await first.getByTitle('New file').click()
  await first.getByLabel('Name').fill('shared.txt')
  await first.getByLabel('Name').press('Enter')
  await expect(second.locator('.tree-name', { hasText: 'shared.txt' })).toBeVisible()

  // History survives a reload because chat is persisted before it is broadcast.
  await second.reload()
  await expect(second.locator('.chat-messages')).toContainText('hello from the first tab')
})
