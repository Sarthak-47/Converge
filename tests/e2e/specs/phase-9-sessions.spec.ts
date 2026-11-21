import { expect, test, type Browser, type Page } from '@playwright/test'
import { answer, createFile, createWorkspace, editorText, openFile, register, typeAtEnd, typeAtStart, uniqueEmail, waitUntilSaved } from './helpers.ts'

/**
 * Phase 9 exit (design §13.3, §13.8, §13.9): two members' agents work one session, and a takeover race has
 * exactly one winner. Agents run on the scripted fake model (see phase-8-agents.spec.ts).
 */
const tool = (name: string, input: object) => `@tool ${name} ${JSON.stringify(input)}`

/** The text under comment highlights; Monaco splits a decoration across token spans. */
const highlighted = async (page: Page) =>
  (await page.locator('.comment-range').allTextContents()).join('').replace(/ /g, ' ')

type Person = { page: Page; email: string; close: () => Promise<void> }

async function person(browser: Browser, name: string): Promise<Person> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const email = uniqueEmail(name.toLowerCase())
  await register(page, email, name)
  return { page, email, close: () => context.close() }
}

async function invite(owner: Page, who: Person, role: 'EDITOR' | 'COMMENTER') {
  await owner.getByRole('button', { name: 'Members' }).click()
  await owner.getByLabel('Email to invite').fill(who.email)
  await owner.getByLabel('Role for the invitation').selectOption(role)
  await owner.getByRole('button', { name: 'Invite' }).click()
  await expect(owner.locator('.dialog .notice')).toContainText('was added')
  await owner.reload()
}

async function openSession(page: Page, workspaceUrl: string, task: string) {
  await page.goto(workspaceUrl)
  await page.getByRole('tab', { name: 'Sessions' }).click()
  await page.getByRole('button', { name: new RegExp(task) }).click()
}

async function saveKey(page: Page, key: string) {
  await page.getByLabel('Your Anthropic API key').fill(key)
  await page.getByRole('button', { name: 'Save key' }).click()
  await expect(page.getByLabel(/Prompt your agent/)).toBeVisible()
}

async function prompt(page: Page, lines: string[]) {
  await page.getByLabel(/Prompt your agent/).fill(lines.join('\n'))
  await page.getByRole('button', { name: 'Send to agent' }).click()
}

test("two members' agents work one session, and a takeover race has exactly one winner", async ({ browser, page }) => {
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Session check')
  await createFile(page, 'signup.ts')
  await typeAtEnd(page, 'function signup(user) {')
  await page.keyboard.press('Enter')
  await page.keyboard.type('save(user)')
  await waitUntilSaved(page)
  const workspaceUrl = page.url()
  const ben = await person(browser, 'Ben')
  const cara = await person(browser, 'Cara')
  await invite(page, ben, 'EDITOR')
  await invite(page, cara, 'EDITOR')

  // Asha starts a session; her agent proposes the plan and does the first step.
  await page.getByRole('tab', { name: 'Sessions' }).click()
  await page.getByLabel('New session: what should get done?').fill('Harden signup')
  await page.getByRole('button', { name: 'Start session' }).click()
  await saveKey(page, 'sk-ant-test-e2e-asha-000000001')
  await prompt(page, [
    'Plan the work and validate the email.',
    tool('propose_plan', { steps: ['Validate email', 'Log failures'] }),
    tool('update_step', { position: 1, status: 'IN_PROGRESS' }),
    tool('edit_file', { path: 'signup.ts', old_string: 'save(user)', new_string: 'if (!user.email) throw new Error("email required")\nsave(user)' }),
    tool('update_step', { position: 1, status: 'DONE' }),
  ])
  const ashaLane = page.getByLabel("Asha's lane")
  await expect(ashaLane.locator('.agent-status').last()).toHaveText('Done', { timeout: 30_000 })
  await expect(page.getByLabel('Step 1: Validate email')).toContainText('Done')
  await expect(page.getByLabel('Step 2: Log failures')).toContainText('Asha')

  // Ben joins with his own agent and works the same session, in the same file.
  await openSession(ben.page, workspaceUrl, 'Harden signup')
  await ben.page.getByRole('button', { name: 'Join with my agent' }).click()
  await saveKey(ben.page, 'sk-ant-test-e2e-ben-0000000001')
  await prompt(ben.page, [
    'Add a trace line at the top.',
    tool('edit_file', { path: 'signup.ts', old_string: 'function signup(user) {', new_string: '// traced by Ben\'s agent\nfunction signup(user) {' }),
  ])
  await expect(ben.page.getByLabel("Ben's lane").locator('.agent-status').last()).toHaveText('Done', { timeout: 30_000 })
  await expect(page.getByLabel("Ben's lane")).toBeVisible({ timeout: 20_000 })
  await openFile(page, 'signup.ts')
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain("traced by Ben's agent")
  expect(await editorText(page)).toContain('email required')

  // Ben and Cara both try to take over from Asha at the same moment: exactly one wins.
  await openSession(cara.page, workspaceUrl, 'Harden signup')
  await saveKey(cara.page, 'sk-ant-test-e2e-cara-000000001')
  await openSession(ben.page, workspaceUrl, 'Harden signup')
  for (const p of [ben.page, cara.page]) {
    await expect(p.locator('.session-head')).toContainText('driven by Asha')
  }
  // Two clicks from a test are never truly simultaneous: if the first takeover's update reached the other
  // page before its click, that click would rightly take over from the new driver. Holding back both pages'
  // session reloads for a moment makes both requests carry the same version, so they really race.
  const holdReloads = (p: typeof page) => p.route(/\/api\/v1\/sessions\/[^/]+$/, async (route) => {
    if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 3000))
    await route.continue()
  })
  await Promise.all([holdReloads(ben.page), holdReloads(cara.page)])
  await Promise.all([
    ben.page.getByRole('button', { name: 'Take over' }).click(),
    cara.page.getByRole('button', { name: 'Take over' }).click(),
  ])
  await expect(page.locator('.session-head')).not.toContainText('driven by Asha', { timeout: 20_000 })
  const head = (await page.locator('.session-head').textContent()) ?? ''
  const winner = head.includes('driven by Ben') ? ben : cara
  const loser = winner === ben ? cara : ben
  expect(head).toMatch(/driven by (Ben|Cara)/)
  await expect(loser.page.getByRole('status').filter({ hasText: 'Someone else took over first' })).toBeVisible()
  // The winner's agent resumes on the winner's own key.
  const winnerName = winner === ben ? 'Ben' : 'Cara'
  await expect(page.getByLabel(`${winnerName}'s lane`).locator('.agent-prompt').last())
    .toContainText(`taking over this session from Asha`, { timeout: 20_000 })
  await expect(page.getByLabel(`${winnerName}'s lane`)).toContainText(`on ${winnerName}'s key`)

  await ben.close()
  await cara.close()
})

test('a comment on code follows teammates’ edits and is labelled outdated when the code is deleted', async ({ browser, page }) => {
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Comment check')
  await createFile(page, 'notes.ts')
  await typeAtEnd(page, 'const answer = 42')
  await page.keyboard.press('Enter')
  await page.keyboard.type('const other = 1')
  await waitUntilSaved(page)
  const workspaceUrl = page.url()
  const ben = await person(browser, 'Ben')
  await invite(page, ben, 'EDITOR')
  await openFile(page, 'notes.ts')

  // Select the first line and comment on it.
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Shift+End')
  await page.getByRole('button', { name: 'Comment' }).click()
  await answer(page, 'Name this constant better')
  const strip = page.getByLabel('Comments on this file')
  await expect(strip).toContainText('Asha: Name this constant better')
  await expect.poll(() => highlighted(page)).toBe('const answer = 42')

  // Ben types above it: the highlight follows the code.
  await ben.page.goto(workspaceUrl)
  await openFile(ben.page, 'notes.ts')
  await expect(ben.page.getByLabel('Comments on this file')).toContainText('Name this constant better')
  await typeAtStart(ben.page, 'added above ')
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain('added above const answer = 42')
  await expect.poll(() => highlighted(page)).toBe('const answer = 42')

  // Deleting the commented code keeps the comment but labels it outdated.
  await ben.page.locator('.monaco-editor .view-lines').click()
  await ben.page.keyboard.press('ControlOrMeta+Home')
  await ben.page.keyboard.press('Shift+End')
  await ben.page.keyboard.press('Backspace')
  await expect(strip).toContainText('outdated', { timeout: 20_000 })
  await expect(page.locator('.comment-range')).toHaveCount(0)
  await ben.close()
})
