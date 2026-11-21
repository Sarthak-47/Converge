import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { answer, createWorkspace, editorText, openFile, register, uniqueEmail } from './helpers.ts'

/**
 * Phase 12 exit (design §10): finishing a session opens a pull request. The stack runs the fake GitHub
 * (COMPOSE_PROFILES=fake-github, GIT_ALLOW_INSECURE_REMOTES=true, CONVERGE_GITHUB_API_URL=http://fake-github:9200/api):
 * the worker pushes over real Git smart HTTP and opens the pull request through the fake REST API, which this
 * test then inspects on its host port.
 */
const FAKE_GITHUB = process.env.E2E_FAKE_GITHUB_URL ?? 'http://localhost:9200'
const TOKEN = 'ghp_fake_token_for_tests'
const tool = (name: string, input: object) => `@tool ${name} ${JSON.stringify(input)}`

test('finishing a session opens a pull request with the session’s work', async ({ page, request }) => {
  test.setTimeout(180_000)
  const repo = `app-${Date.now()}`
  const seeded = await request.post(`${FAKE_GITHUB}/__test/repos`, { data: { owner: 'acme', repo, files: { 'README.md': '# app\n' } } })
  expect(seeded.ok()).toBe(true)

  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'PR check')
  await page.getByRole('button', { name: 'Repository' }).click()
  await page.getByLabel('Repository URL').fill(`http://fake-github:9200/acme/${repo}.git`)
  await page.getByLabel('Access token').fill(TOKEN)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(`Connected to acme/${repo}`)
  await expect(page.getByRole('dialog')).not.toContainText(TOKEN)
  await page.getByRole('button', { name: 'Close' }).click()

  await page.getByRole('tab', { name: 'Sessions' }).click()
  await page.getByLabel('New session: what should get done?').fill('Add signup')
  await page.getByRole('button', { name: 'Start session' }).click()
  await page.getByLabel('Your Anthropic API key').fill('sk-ant-test-e2e-asha-git-000001')
  await page.getByRole('button', { name: 'Save key' }).click()
  await page.getByLabel(/Prompt your agent/).fill(
    tool('create_file', { path: 'src/signup.ts', content: 'export function signup() {\n  return true\n}\n' }),
  )
  await page.getByRole('button', { name: 'Send to agent' }).click()
  await expect(page.getByLabel("Asha's lane").locator('.agent-status').last()).toHaveText('Done', { timeout: 30_000 })

  await page.getByRole('button', { name: 'Finish and open pull request' }).click()
  const prs = page.getByLabel('Pull requests')
  await expect(prs.getByRole('link', { name: /Pull request #\d+/ })).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.session-head')).toContainText('Finished')

  // On "GitHub": one pull request from a converge/ branch, with the session's file on top of main.
  const pulls = (await (await request.get(`${FAKE_GITHUB}/__test/pulls`)).json()) as Array<{ repo: string; title: string; head: string; base: string; body: string }>
  const pr = pulls.find((p) => p.repo === repo)
  expect(pr).toMatchObject({ title: 'Add signup', base: 'main' })
  expect(pr!.head).toMatch(/^converge\/add-signup-[0-9a-f]{8}$/)
  expect(pr!.body).toContain('**Task:** Add signup')
  const head = (await (await request.get(`${FAKE_GITHUB}/__test/repos/acme/${repo}/branches/${encodeURIComponent(pr!.head)}`)).json()) as { author: string; files: string[] }
  expect(head.author).toBe('Asha')
  expect(head.files.sort()).toEqual(['README.md', 'src/signup.ts'])
})

test('importing a repository brings its text files into the workspace', async ({ page, request }) => {
  test.setTimeout(120_000)
  const repo = `import-${Date.now()}`
  await request.post(`${FAKE_GITHUB}/__test/repos`, {
    data: { owner: 'acme', repo, files: { 'README.md': '# imported from git\n', 'src/util.ts': 'export const imported = true\n', 'logo.png': '\u0000\u0001binary' } },
  })
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Import check')
  await page.getByRole('button', { name: 'Repository' }).click()
  await page.getByLabel('Repository URL').fill(`http://fake-github:9200/acme/${repo}.git`)
  await page.getByLabel('Access token').fill(TOKEN)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Import files from main' }).click()
  await expect(page.getByLabel('Recent Git operations')).toContainText('Imported main: 2 new, 0 updated, 0 unchanged, 1 skipped', { timeout: 60_000 })
  await page.getByRole('button', { name: 'Close' }).click()

  await openFile(page, 'README.md')
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain('# imported from git')
  await expect(page.locator('.tree-name', { hasText: 'logo.png' })).toHaveCount(0)
})

test('a signed push from GitHub imports the default branch automatically', async ({ page, request }) => {
  test.setTimeout(120_000)
  const repo = `hook-${Date.now()}`
  await request.post(`${FAKE_GITHUB}/__test/repos`, {
    data: { owner: 'acme', repo, files: { 'CHANGELOG.md': '# pushed to main\n' } },
  })
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Webhook check')
  await page.getByRole('button', { name: 'Repository' }).click()
  await page.getByLabel('Repository URL').fill(`http://fake-github:9200/acme/${repo}.git`)
  await page.getByLabel('Access token').fill(TOKEN)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()

  // Turning automatic import on shows the payload URL and the secret once, as GitHub needs them.
  await page.getByLabel('Automatic import').getByRole('button', { name: 'Turn on' }).click()
  await expect(page.getByLabel('Automatic import')).toContainText('Automatic import is on')
  const hookUrl = await page.getByLabel('Payload URL').inputValue()
  const secret = await page.getByLabel('Secret').inputValue()

  // GitHub's delivery: a push to main, signed with the secret.
  const body = JSON.stringify({ ref: 'refs/heads/main' })
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  const delivery = await request.post(hookUrl, {
    data: body,
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': `e2e-${repo}`, 'X-Hub-Signature-256': signature },
  })
  expect(delivery.status()).toBe(202)
  // A forged delivery is refused, and looks like there is no webhook at all.
  const forged = await request.post(hookUrl, {
    data: body,
    headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'forged', 'X-Hub-Signature-256': 'sha256=00' },
  })
  expect(forged.status()).toBe(404)

  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('.tree-name', { hasText: 'CHANGELOG.md' })).toBeVisible({ timeout: 60_000 })
  await openFile(page, 'CHANGELOG.md')
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain('# pushed to main')
})

test('a push deletes on its branch what was deleted or moved here, and nothing else', async ({ page, request }) => {
  test.setTimeout(150_000)
  const repo = `tidy-${Date.now()}`
  await request.post(`${FAKE_GITHUB}/__test/repos`, {
    data: {
      owner: 'acme',
      repo,
      files: { 'README.md': '# tidy\n', 'src/util.ts': 'export const util = 1\n', 'src/old.ts': 'export const old = 1\n', 'logo.png': '\u0000\u0001binary' },
    },
  })
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Tidy check')
  await page.getByRole('button', { name: 'Repository' }).click()
  await page.getByLabel('Repository URL').fill(`http://fake-github:9200/acme/${repo}.git`)
  await page.getByLabel('Access token').fill(TOKEN)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Import files from main' }).click()
  await expect(page.getByLabel('Recent Git operations')).toContainText('Imported main: 3 new', { timeout: 60_000 })
  await page.getByRole('button', { name: 'Close' }).click()

  // Delete one imported file and move another to the top level.
  await page.locator('.tree-row[title="src/util.ts"]').hover()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete util.ts' }).click()
  await expect(page.locator('.tree-row[title="src/util.ts"]')).toHaveCount(0)
  await page.locator('.tree-row[title="src/old.ts"]').hover()
  await page.getByRole('button', { name: 'Move old.ts' }).click()
  await answer(page, '')
  await expect(page.locator('.tree-row[title="old.ts"]')).toBeVisible()

  await page.getByRole('button', { name: 'Repository' }).click()
  const form = page.getByRole('form', { name: 'Push to a branch' })
  await expect(form.getByLabel('Push to branch')).toHaveValue('converge/tidy-check')
  await form.getByLabel('Commit message').fill('Tidy up')
  await form.getByRole('button', { name: 'Push' }).click()
  await expect(page.getByLabel('Recent Git operations')).toContainText('Push on converge/tidy-check', { timeout: 60_000 })

  // The deleted file and the old path are gone; the binary Converge never held is untouched.
  const head = (await (await request.get(`${FAKE_GITHUB}/__test/repos/acme/${repo}/branches/converge%2Ftidy-check`)).json()) as { author: string; files: string[] }
  expect(head.author).toBe('Asha')
  expect(head.files.sort()).toEqual(['README.md', 'logo.png', 'old.ts'])
})
