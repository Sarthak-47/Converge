import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { createFile, createWorkspace, editorText, register, typeAtEnd, uniqueEmail, waitUntilSaved } from './helpers.ts'

/**
 * The desktop app end to end (design §12, Phase 7): sign in inside the real Electron app, start syncing a
 * workspace to a folder, and check that edits flow both ways between the editor and the file on disk.
 * Skipped where the Electron binary is not installed (CI skips that download; run
 * `npm run setup -w apps/desktop` once locally).
 */
const repo = path.resolve(import.meta.dirname, '../../..')
const electronBinary = (() => {
  try {
    const binary = createRequire(import.meta.url)('electron') as unknown as string
    return existsSync(binary) ? binary : null
  } catch {
    return null
  }
})()

test.skip(!electronBinary, 'Electron binary not installed')

test('the desktop app mirrors a workspace into a local folder, both ways', async () => {
  const folder = path.join(repo, '.tmp', `desktop-e2e-${Date.now()}`)
  await mkdir(folder, { recursive: true })
  const app = await electron.launch({
    executablePath: electronBinary!,
    args: [path.join(repo, 'apps', 'desktop')],
    env: { ...process.env, CONVERGE_URL: 'http://localhost:8000', CONVERGE_E2E_SYNC_FOLDER: folder },
  })
  try {
    const window = await app.firstWindow()
    await register(window, uniqueEmail('desktop'), 'Desktop')
    await createWorkspace(window, 'Desktop check')
    await createFile(window, 'app.ts')
    await typeAtEnd(window, 'export const typedInTheApp = 1')
    await waitUntilSaved(window)

    await window.getByRole('button', { name: 'Sync to folder…' }).click()
    await expect(window.locator('.sync-control')).toContainText('Syncing to')

    const onDisk = path.join(folder, 'app.ts')
    await expect.poll(() => readFile(onDisk, 'utf8').catch(() => ''), { timeout: 20_000 }).toContain('typedInTheApp')

    // An ordinary save on disk (as an external editor or formatter would do) reaches the open editor.
    await writeFile(onDisk, 'export const typedInTheApp = 1\nexport const savedOnDisk = 2\n')
    await expect.poll(() => editorText(window), { timeout: 20_000 }).toContain('savedOnDisk')

    // And typing in the app reaches the file on disk.
    await typeAtEnd(window, ' // typed after sync')
    await expect.poll(() => readFile(onDisk, 'utf8'), { timeout: 20_000 }).toContain('typed after sync')
  } finally {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  }
})
