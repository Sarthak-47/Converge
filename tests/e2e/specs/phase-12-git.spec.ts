import { expect, test } from '@playwright/test'
import { createWorkspace, register, uniqueEmail } from './helpers.ts'

/**
 * Phase 12 exit (design §10): finishing a session opens a pull request. The stack runs the fake GitHub
 * (COMPOSE_PROFILES=fake-github, GIT_ALLOW_INSECURE_REMOTES=true, GITHUB_API_URL=http://fake-github:9200/api):
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
