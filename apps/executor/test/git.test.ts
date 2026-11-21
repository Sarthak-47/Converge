import { createCipheriv, randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitError, GitWorker, safePath, type GitRequest } from '../src/git.js'
import { openSealed } from '../src/secrets.js'
import { FakeGithub } from '../src/testing/fakeGithub.js'

/**
 * Server-side Git (design §10) against a real Git server (git http-backend behind the fake GitHub). Folders
 * live in the repository's .tmp, never in the system temp directory.
 */
const SCRATCH = path.resolve(import.meta.dirname, '../../../.tmp/git-tests')
const TOKEN = 'ghp_test_token_0123456789'

let github: FakeGithub
let baseUrl: string
let worker: GitWorker

const author = { name: 'Asha', email: 'asha-id@users.noreply.converge.dev' }

function request(files: Record<string, string>, overrides: Partial<GitRequest> = {}): GitRequest {
  return {
    type: 'PULL_REQUEST',
    branch: 'converge/add-validation-1234abcd',
    message: 'Add validation',
    title: 'Add validation',
    body: 'Opened from a Converge session.',
    author,
    files: new Map(Object.entries(files)),
    ...overrides,
  }
}

const target = (repo: string, token = TOKEN) => ({ remoteUrl: `${baseUrl}/acme/${repo}.git`, defaultBranch: 'main', owner: 'acme', repo, token })

beforeAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true })
  github = new FakeGithub(path.join(SCRATCH, 'remote'), TOKEN)
  baseUrl = await github.start()
  worker = new GitWorker(path.join(SCRATCH, 'worker'), `${baseUrl}/api`)
}, 60_000)

afterAll(async () => {
  await github.stop()
})

describe('opening a pull request from the workspace', () => {
  it('commits the workspace text on a branch from main, pushes it and opens the PR', async () => {
    github.createRepo('acme', 'app', { 'README.md': '# app\n', 'src/old.ts': 'export const old = 1\n' })
    const result = await worker.run('ws-1', target('app'), request({
      'src/signup.ts': 'export function signup() {}\n',
      'README.md': '# app\n\nNow with signup.\n',
    }))

    expect(result).toMatchObject({ branch: 'converge/add-validation-1234abcd', changedFiles: 2, prNumber: 1 })
    expect(result.prUrl).toBe(`${baseUrl}/acme/app/pull/1`)
    expect(github.pulls[0]).toMatchObject({ title: 'Add validation', head: 'converge/add-validation-1234abcd', base: 'main' })
    const head = github.headCommit('acme', 'app', 'converge/add-validation-1234abcd')
    expect(head).toMatchObject({ author: 'Asha', email: author.email, subject: 'Add validation' })
    // Files Converge does not hold are kept: it only adds and modifies.
    expect(head.files.sort()).toEqual(['README.md', 'src/old.ts', 'src/signup.ts'])
    expect(github.fileAt('acme', 'app', 'converge/add-validation-1234abcd', 'README.md')).toContain('Now with signup.')
  }, 60_000)

  it('updates the same pull request when run again, instead of opening another', async () => {
    const again = await worker.run('ws-1', target('app'), request({ 'src/signup.ts': 'export function signup(user) {}\n' }))
    expect(again.prNumber).toBe(1)
    expect(github.pulls).toHaveLength(1)
    expect(github.fileAt('acme', 'app', 'converge/add-validation-1234abcd', 'src/signup.ts')).toContain('signup(user)')
  }, 60_000)

  it('reports nothing to commit when the workspace matches main', async () => {
    github.createRepo('acme', 'same', { 'a.txt': 'same\n' })
    await expect(worker.run('ws-2', target('same'), request({ 'a.txt': 'same\n' }))).rejects.toThrow('Nothing to commit')
  }, 60_000)

  it('never writes into .git, and never puts the token in its log', async () => {
    github.createRepo('acme', 'safe', { 'a.txt': 'a\n' })
    const result = await worker.run('ws-3', target('safe'), request({
      '.git/hooks/post-commit': '#!/bin/sh\necho pwned > /tmp/pwned\n',
      'src/.git/config': 'evil',
      'b.txt': 'b\n',
    }, { type: 'PUSH_BRANCH', branch: 'converge/safe' }))
    expect(github.headCommit('acme', 'safe', 'converge/safe').files.sort()).toEqual(['a.txt', 'b.txt'])
    expect(result.prUrl).toBeUndefined()

    try {
      await worker.run('ws-4', target('safe', 'ghp_wrong_token_9999'), request({ 'c.txt': 'c\n' }, { type: 'PUSH_BRANCH', branch: 'converge/x' }))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(GitError)
      expect((error as GitError).message + (error as GitError).log).not.toContain('ghp_wrong_token_9999')
    }
  }, 60_000)

  it('deletes only the paths it is told to, which covers renames and moves', async () => {
    github.createRepo('acme', 'gone', {
      'keep.txt': 'keep\n',
      'old/name.ts': 'export const x = 1\n',
      '[ab].txt': 'brackets are a pattern unless pathspecs are literal\n',
      'a.txt': 'Converge never held this\n',
      'logo.png': 'binary Converge never held\n',
    })
    const result = await worker.run('ws-7', target('gone'), request({
      'keep.txt': 'keep\n',
      'new/name.ts': 'export const x = 1\n',
    }, {
      type: 'PUSH_BRANCH',
      branch: 'converge/tidy',
      // A held path is never deleted, and unsafe or unknown paths are ignored.
      deleted: ['old/name.ts', '[ab].txt', 'keep.txt', '../outside', 'never-there.txt'],
    }))
    expect(github.headCommit('acme', 'gone', 'converge/tidy').files.sort()).toEqual(['a.txt', 'keep.txt', 'logo.png', 'new/name.ts'])
    // Git sees old/name.ts -> new/name.ts as one rename, plus the deleted [ab].txt.
    expect(result.changedFiles).toBe(2)
    expect(result.written.sort()).toEqual(['keep.txt', 'new/name.ts'])
  }, 60_000)

  it('refuses a pull request when the repository has no default branch yet', async () => {
    github.createRepo('acme', 'empty', {})
    await expect(worker.run('ws-5', target('empty'), request({ 'a.txt': 'a' }))).rejects.toThrow('has no main branch')
  }, 60_000)
})

describe('importing the default branch', () => {
  it('reads text files and skips binaries, large files and missing branches', async () => {
    github.createRepo('acme', 'importable', {
      'README.md': '# importable\n',
      'src/main.ts': 'export const answer = 42\n',
      'logo.png': '\u0089PNG\r\n\u001a\n\u0000\u0000binary',
      'big.txt': 'x'.repeat(1024 * 1024 + 1),
    })
    const contents = await worker.readBranch('ws-import', target('importable'))
    expect([...contents.files.keys()].sort()).toEqual(['README.md', 'src/main.ts'])
    expect(contents.files.get('src/main.ts')).toBe('export const answer = 42\n')
    expect(contents.skipped.map((s) => `${s.path}: ${s.reason}`).sort()).toEqual(['big.txt: larger than 1 MB', 'logo.png: binary'])
    expect(contents.sha).toMatch(/^[0-9a-f]{40}$/)

    github.createRepo('acme', 'blank', {})
    await expect(worker.readBranch('ws-blank', target('blank'))).rejects.toThrow('has no main branch to import')
  }, 60_000)
})

describe('paths and credentials', () => {
  it.each([
    ['src/a.ts', true], ['.github/workflows/ci.yml', true], ['.git/config', false], ['src/.GIT/x', false],
    ['../escape', false], ['/abs', false], ['a//b', false], ['C:/x', false], ['a\\b', false],
  ])('safePath(%j) is %s', (file, expected) => expect(safePath(file)).toBe(expected))

  it('opens a value sealed the way the API seals it', () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from('git-credential:ws', 'utf8'))
    const sealed = Buffer.concat([nonce, cipher.update('ghp_secret', 'utf8'), cipher.final(), cipher.getAuthTag()])
    expect(openSealed(sealed, 'git-credential:ws', key.toString('base64'))).toBe('ghp_secret')
    expect(() => openSealed(sealed, 'git-credential:other', key.toString('base64'))).toThrow()
  })
})
