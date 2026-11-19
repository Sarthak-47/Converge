import { expect, test, type Browser } from '@playwright/test'
import { createWorkspace, register, uniqueEmail } from './helpers.ts'

/**
 * Phase 10 exit (design §13.7, Gates C and E): a server-side agent runs tests only after a named approval, and
 * they run inside the sandbox. The stack needs the executor (with the Docker socket) and the fake model.
 */
const tool = (name: string, input: object) => `@tool ${name} ${JSON.stringify(input)}`

async function person(browser: Browser, name: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const email = uniqueEmail(name.toLowerCase())
  await register(page, email, name)
  return { page, email, close: () => context.close() }
}

const TEST_FILE = [
  "import test from 'node:test'",
  "import assert from 'node:assert'",
  "test('adds', () => assert.equal(1 + 1, 2))",
  '',
].join('\n')

test('an agent runs the tests only after a named approval, inside the sandbox', async ({ browser, page }) => {
  test.setTimeout(180_000)
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Approval check')
  const workspaceUrl = page.url()
  const ben = await person(browser, 'Ben')
  await page.getByRole('button', { name: 'Members' }).click()
  await page.getByLabel('Email to invite').fill(ben.email)
  await page.getByLabel('Role for the invitation').selectOption('EDITOR')
  await page.getByRole('button', { name: 'Invite' }).click()
  await expect(page.locator('.dialog .notice')).toContainText('was added')
  await page.reload()

  await page.getByRole('tab', { name: 'Sessions' }).click()
  await page.getByLabel('New session: what should get done?').fill('Make sure math works')
  await page.getByRole('button', { name: 'Start session' }).click()
  await page.getByLabel('Your Anthropic API key').fill('sk-ant-test-e2e-asha-approvals1')
  await page.getByRole('button', { name: 'Save key' }).click()
  await page.getByLabel(/Prompt your agent/).fill([
    'Write a test and run it.',
    tool('create_file', { path: 'tests/math.test.js', content: TEST_FILE }),
    tool('run_command', { command: 'node --test tests/math.test.js' }),
  ].join('\n'))
  await page.getByRole('button', { name: 'Send to agent' }).click()

  // The card shows the exact command; nothing has run yet.
  const card = page.getByRole('group', { name: 'Approval: node --test tests/math.test.js' })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText("Asha's agent asks to run")
  await expect(card).toContainText('no network')
  await expect(card.getByLabel('Job output')).toHaveCount(0)
  await expect(page.getByLabel("Asha's lane").locator('.agent-status').last()).toHaveText('Working…')

  // Ben sees the waiting approval on the board and approves it by name.
  await ben.page.goto(workspaceUrl)
  await ben.page.getByRole('tab', { name: 'Sessions' }).click()
  await ben.page.getByRole('button', { name: /Approval waiting: Asha's agent wants to run "node --test tests\/math.test.js"/ }).click()
  const bensCard = ben.page.getByRole('group', { name: 'Approval: node --test tests/math.test.js' })
  await bensCard.getByRole('button', { name: 'Approve' }).click()

  // It runs in the sandbox, the output streams to everyone, and the agent gets the result.
  for (const p of [page, ben.page]) {
    const c = p.getByRole('group', { name: 'Approval: node --test tests/math.test.js' })
    await expect(c).toContainText('Approved by Ben', { timeout: 30_000 })
    await expect(c.getByLabel('Job output')).toContainText('pass 1', { timeout: 90_000 })
    await expect(c).toContainText('Succeeded (exit 0)')
  }
  const lane = page.getByLabel("Asha's lane")
  await expect(lane.locator('.agent-status').last()).toHaveText('Done', { timeout: 30_000 })
  await expect(lane).toContainText('✓ ran node --test tests/math.test.js (exit 0)')

  // The card is decided: it offers no second answer (the API refuses one too).
  await expect(bensCard.getByRole('button', { name: 'Approve' })).toHaveCount(0)
  await ben.close()
})

test('a denied command never runs', async ({ page }) => {
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Deny check')
  await page.getByRole('tab', { name: 'Sessions' }).click()
  await page.getByLabel('New session: what should get done?').fill('Try a command')
  await page.getByRole('button', { name: 'Start session' }).click()
  await page.getByLabel('Your Anthropic API key').fill('sk-ant-test-e2e-asha-approvals2')
  await page.getByRole('button', { name: 'Save key' }).click()
  await page.getByLabel(/Prompt your agent/).fill(tool('run_command', { command: 'npm test' }))
  await page.getByRole('button', { name: 'Send to agent' }).click()

  const card = page.getByRole('group', { name: 'Approval: npm test' })
  await card.getByRole('button', { name: 'Deny' }).click({ timeout: 30_000 })
  await expect(card).toContainText('Denied by Asha')
  const lane = page.getByLabel("Asha's lane")
  await expect(lane.locator('.agent-status').last()).toHaveText('Done', { timeout: 30_000 })
  await expect(lane).toContainText('✗ run_command: "npm test" was denied by Asha; it did not run.')
  await expect(card.getByLabel('Job output')).toHaveCount(0)
})
