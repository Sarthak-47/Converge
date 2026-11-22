import { expect, test } from '@playwright/test'
import { createFile, createWorkspace, editorText, register, typeAtEnd, uniqueEmail, waitUntilSaved } from './helpers.ts'

/**
 * Bring your own key for any provider (design §13.5): a member with only an OpenAI key names a model and their
 * agent edits the file on it. The stack points every provider at the scripted fake model
 * (COMPOSE_PROFILES=fake-model AGENT_MODEL_URL=http://fake-model:9100), so the key is a test value.
 */
const tool = (name: string, input: object) => `@tool ${name} ${JSON.stringify(input)}`

test('a member brings an OpenAI key, and their agent edits the file on an OpenAI model', async ({ page }) => {
  await register(page, uniqueEmail('asha'), 'Asha')
  await createWorkspace(page, 'Providers')
  await createFile(page, 'app.ts')
  await typeAtEnd(page, 'const a = 1')
  await waitUntilSaved(page)

  await page.getByRole('tab', { name: 'Sessions' }).click()
  await page.getByLabel('New session: what should get done?').fill('Try another provider')
  await page.getByRole('button', { name: 'Start session' }).click()
  await page.getByRole('radio', { name: 'OpenAI' }).click()
  await page.getByLabel('Your OpenAI API key').fill('sk-ant-test-e2e-wrong-provider')
  await page.getByRole('button', { name: 'Save key' }).click()
  await expect(page.locator('.agent-key-form').getByRole('alert')).toContainText('not OpenAI')
  await page.getByLabel('Your OpenAI API key').fill('sk-test-e2e-openai-asha-0001')
  await page.getByRole('button', { name: 'Save key' }).click()

  // Without an Anthropic key no Claude model is offered: the member names a model on OpenAI.
  await expect(page.locator('.agent-composer')).toContainText("Uses Asha's OpenAI API key (…0001)")
  await expect(page.getByRole('button', { name: 'Send to agent' })).toBeDisabled()
  await page.getByLabel('OpenAI model ID').fill('gpt-e2e')
  await page.getByLabel(/Prompt your agent/).fill([
    'Add b.',
    tool('read_file', { path: 'app.ts' }),
    tool('edit_file', { path: 'app.ts', old_string: 'const a = 1', new_string: 'const a = 1\nconst b = "from an OpenAI model"' }),
  ].join('\n'))
  await page.getByRole('button', { name: 'Send to agent' }).click()

  const turn = page.locator('.agent-turn').last()
  await expect(turn.locator('.agent-status')).toHaveText('Done', { timeout: 30_000 })
  await expect(turn.locator('.agent-tool.ok', { hasText: 'edited app.ts' })).toBeVisible()
  await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain('from an OpenAI model')

  // The key list shows only a hint, and a key can be removed.
  await page.locator('.agent-keys > summary').click()
  await expect(page.getByRole('list', { name: 'Your API keys' })).toContainText('OpenAI …0001')
  await page.getByRole('button', { name: 'Remove your OpenAI key' }).click()
  await expect(page.getByLabel('Your Anthropic API key')).toBeVisible()
})
