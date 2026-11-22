import { expect, test, type Browser } from '@playwright/test'
import { createFile, createWorkspace, editorText, openFile, register, typeAtEnd, typeAtStart, uniqueEmail, waitUntilSaved } from './helpers.ts'

/**
 * Phase 8 exit (design §13.2, §19): a member's agent and a teammate edit one file at once and converge, and
 * reverting the agent's turn keeps the teammate's edits. The stack must point the agent runner at the
 * scripted fake model (COMPOSE_PROFILES=fake-model AGENT_MODEL_URL=http://fake-model:9100), so the
 * "API key" below is a test value and no real API is called.
 */
const TEST_KEY = 'sk-ant-test-e2e-not-a-real-key-0001'

async function newPerson(browser: Browser, name: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const email = uniqueEmail(name.toLowerCase())
  await register(page, email, name)
  return { context, page, email }
}

const tool = (name: string, input: object) => `@tool ${name} ${JSON.stringify(input)}`

test("a teammate's agent edits alongside a person, and reverting its turn keeps the person's edits", async ({ browser, page }) => {
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Agent check')
  await createFile(page, 'app.ts')
  await typeAtEnd(page, 'const a = 1')
  await page.keyboard.press('Enter')
  await page.keyboard.type('const b = 2')
  await waitUntilSaved(page)
  const workspaceUrl = page.url()

  const ben = await newPerson(browser, 'Ben')
  await page.getByRole('button', { name: 'Members' }).click()
  await page.getByLabel('Email to invite').fill(ben.email)
  await page.getByLabel('Role for the invitation').selectOption('EDITOR')
  await page.getByRole('button', { name: 'Invite' }).click()
  await expect(page.locator('.dialog .notice')).toContainText('Ben was added')
  await page.reload()
  await openFile(page, 'app.ts')
  await ben.page.goto(workspaceUrl)
  await openFile(ben.page, 'app.ts')

  // Asha adds her own key; only a hint is ever shown back.
  await page.getByRole('tab', { name: 'Sessions' }).click()
  await page.getByLabel('New session: what should get done?').fill('Add a constant')
  await page.getByRole('button', { name: 'Start session' }).click()
  await page.getByLabel('Your Anthropic API key').fill(TEST_KEY)
  await page.getByRole('button', { name: 'Save key' }).click()
  await expect(page.locator('.agent-composer')).toContainText("Uses Asha's Anthropic API key (…0001)")

  const added = 'const fromAgent = "written by the agent while Ben typed above it"'
  await page.getByLabel(/Prompt your agent/).fill([
    'Add a constant after b.',
    '@slow 1500',
    tool('read_file', { path: 'app.ts' }),
    tool('edit_file', { path: 'app.ts', old_string: 'const b = 2', new_string: `const b = 2\n${added}` }),
  ].join('\n'))
  await page.getByRole('button', { name: 'Send to agent' }).click()

  // Ben sees Asha's agent join his file, and types while it works.
  await expect(ben.page.locator('.editor-peers')).toContainText("Asha's agent", { timeout: 20_000 })
  await typeAtStart(ben.page, 'ben typed this ')

  const turn = page.locator('.agent-turn').last()
  await expect(turn.locator('.agent-status')).toHaveText('Done', { timeout: 30_000 })
  await expect(turn.locator('.agent-tool.ok', { hasText: 'edited app.ts' })).toBeVisible()
  await expect(turn).toContainText('on Asha\'s key')
  for (const p of [page, ben.page]) {
    await expect.poll(() => editorText(p), { timeout: 20_000 }).toContain('fromAgent')
    await expect.poll(() => editorText(p), { timeout: 20_000 }).toContain('ben typed this const a = 1')
  }
  expect(await editorText(page)).toBe(await editorText(ben.page))

  // Ben reverts Asha's agent turn from his own lane view: the agent's line goes, his typing stays.
  await ben.page.getByRole('tab', { name: 'Sessions' }).click()
  await ben.page.getByRole('button', { name: /Add a constant/ }).click()
  const bensView = ben.page.locator('.agent-turn').last()
  await expect(bensView).toContainText("Asha's agent")
  await bensView.getByRole('button', { name: 'Revert this turn' }).click()
  await expect(bensView).toContainText('Reverted', { timeout: 20_000 })
  for (const p of [page, ben.page]) {
    await expect.poll(() => editorText(p), { timeout: 20_000 }).not.toContain('fromAgent')
    expect(await editorText(p)).toContain('ben typed this const a = 1')
    expect(await editorText(p)).toContain('const b = 2')
  }
  await ben.context.close()
})
