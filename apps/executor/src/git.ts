import { spawn } from 'node:child_process'
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type GitTarget = {
  remoteUrl: string
  defaultBranch: string
  owner: string
  repo: string
  token: string
}

export type GitRequest = {
  type: 'PULL_REQUEST' | 'PUSH_BRANCH'
  branch: string
  message: string
  title?: string
  body?: string
  author: { name: string; email: string }
  /** The workspace's stored text, by path. */
  files: Map<string, string>
  /**
   * Paths to delete on the branch: ones Converge knows are on the default branch but the workspace no
   * longer holds (deleted, renamed or moved). Anything else Converge does not hold is left as it is.
   */
  deleted?: string[]
}

/** What an import read from the repository: text files to apply, and what it left out and why. */
export type BranchContents = { sha: string; files: Map<string, string>; skipped: Array<{ path: string; reason: string }> }

/** Files larger than this stay out of live documents (the desktop sync uses the same limit, design §12.7). */
export const MAX_IMPORT_BYTES = 1024 * 1024

export type GitResult = {
  branch: string
  sha: string
  changedFiles: number
  /** The workspace paths written into the commit (what the branch now holds from Converge). */
  written: string[]
  prUrl?: string
  prNumber?: number
}

export class GitError extends Error {
  constructor(message: string, readonly log: string) {
    super(message)
  }
}

/**
 * Hardened Git for content that comes from users (design §14): no hooks, no file:// remotes, no system or
 * user config, no credential helpers, no prompts. The token reaches Git only through GIT_ASKPASS reading an
 * environment variable, so it never appears in arguments, config files or logs.
 */
const SAFE_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.autocrlf=false',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ext.allow=never',
  '-c', 'credential.helper=',
  '-c', 'commit.gpgsign=false',
  '-c', 'init.defaultBranch=main',
  '-c', 'advice.detachedHead=false',
]

/** A workspace path is written into the work tree only if it cannot reach Git's own files or leave the tree. */
export function safePath(file: string): boolean {
  if (!file || file.length > 1000 || file.startsWith('/') || file.includes('\\') || /^[A-Za-z]:/.test(file)) return false
  return file.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

export class GitWorker {
  private readonly askpass: string

  constructor(private readonly root: string, private readonly githubApi: string) {
    this.askpass = path.join(root, '.askpass.sh')
  }

  /** Runs one operation in the workspace's own checkout under the worker's storage. */
  async run(workspaceId: string, target: GitTarget, request: GitRequest): Promise<GitResult> {
    const log: string[] = []
    const dir = path.join(this.root, workspaceId)
    const redact = (text: string) => target.token ? text.split(target.token).join('***') : text
    const git = (args: string[], options: { allowFailure?: boolean } = {}) =>
      this.git(dir, args, target.token, request.author, log, redact, options.allowFailure ?? false)

    try {
      await this.prepare()
      await mkdir(dir, { recursive: true })
      if (!(await exists(path.join(dir, '.git')))) {
        await git(['init', '-q'])
        await git(['remote', 'add', 'origin', target.remoteUrl])
      } else {
        await git(['remote', 'set-url', 'origin', target.remoteUrl])
      }

      const base = `refs/remotes/origin/${target.defaultBranch}`
      const fetched = await git(['fetch', '-q', '--depth=50', 'origin', `+refs/heads/${target.defaultBranch}:${base}`], { allowFailure: true })
      const hasBase = fetched.code === 0
      // Only a missing branch means "empty repository"; anything else (authentication, network, a server
      // that cannot serve Git) is reported as the failure it is.
      if (!hasBase && !/couldn't find remote ref|could not find remote ref/i.test(fetched.stderr)) {
        throw new GitError(`Could not fetch from the repository: ${redact(fetched.stderr.trim().split('\n').at(-1) ?? 'unknown error')}`, redact(log.join('')))
      }
      if (!hasBase && request.type === 'PULL_REQUEST') {
        throw new GitError(`The repository has no ${target.defaultBranch} branch to open a pull request against`, redact(log.join('')))
      }
      // The branch is rebuilt from the default branch every time: it is Converge's projection of the workspace.
      if (hasBase) {
        await git(['checkout', '-q', '-f', '-B', request.branch, base])
      } else {
        await git(['checkout', '-q', '-f', '--orphan', request.branch])
        await git(['rm', '-rfq', '--cached', '--ignore-unmatch', '.'])
      }
      await git(['clean', '-fdxq'])

      const written: string[] = []
      for (const [file, text] of request.files) {
        if (!safePath(file)) {
          log.push(`skipped unsafe path ${JSON.stringify(file)}\n`)
          continue
        }
        const target = path.join(dir, ...file.split('/'))
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, text)
        written.push(file)
      }
      for (let i = 0; i < written.length; i += 200) await git(['add', '--', ...written.slice(i, i + 200)])
      // Deletes only what the caller named; files Converge never held stay as they are on the branch.
      const deleted = (request.deleted ?? []).filter((file) => safePath(file) && !request.files.has(file))
      for (let i = 0; i < deleted.length; i += 200) {
        await git(['rm', '-q', '--ignore-unmatch', '--', ...deleted.slice(i, i + 200)])
      }
      const staged = await git(['diff', '--cached', '--name-only'])
      const changedFiles = staged.stdout.split('\n').filter(Boolean).length
      if (changedFiles === 0) {
        throw new GitError(`Nothing to commit: the workspace matches ${hasBase ? target.defaultBranch : 'an empty repository'}`, redact(log.join('')))
      }
      await git(['commit', '-q', '-m', request.message], {})
      const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim()
      await git(['push', '-q', '--force', 'origin', `HEAD:refs/heads/${request.branch}`])

      const result: GitResult = { branch: request.branch, sha, changedFiles, written }
      if (request.type === 'PULL_REQUEST') Object.assign(result, await this.pullRequest(target, request, log))
      return result
    } catch (error) {
      if (error instanceof GitError) throw error
      throw new GitError(redact((error as Error).message), redact(log.join('')))
    }
  }

  /**
   * Reads the default branch for an import (design §10.2): regular text files only. Symbolic links,
   * submodules, binaries and files over 1 MB are skipped and reported, as are paths that could not be
   * written into a workspace safely.
   */
  async readBranch(workspaceId: string, target: GitTarget): Promise<BranchContents> {
    const log: string[] = []
    const dir = path.join(this.root, workspaceId)
    const redact = (text: string) => target.token ? text.split(target.token).join('***') : text
    const author = { name: 'Converge', email: 'converge@users.noreply.converge.dev' }
    const git = (args: string[], allowFailure = false) => this.git(dir, args, target.token, author, log, redact, allowFailure)
    try {
      await this.prepare()
      await mkdir(dir, { recursive: true })
      if (!(await exists(path.join(dir, '.git')))) {
        await git(['init', '-q'])
        await git(['remote', 'add', 'origin', target.remoteUrl])
      } else {
        await git(['remote', 'set-url', 'origin', target.remoteUrl])
      }
      const ref = `refs/remotes/origin/${target.defaultBranch}`
      const fetched = await git(['fetch', '-q', '--depth=1', 'origin', `+refs/heads/${target.defaultBranch}:${ref}`], true)
      if (fetched.code !== 0) {
        const missing = /couldn't find remote ref|could not find remote ref/i.test(fetched.stderr)
        throw new GitError(missing ? `The repository has no ${target.defaultBranch} branch to import`
          : `Could not fetch from the repository: ${redact(fetched.stderr.trim().split('\n').at(-1) ?? 'unknown error')}`, redact(log.join('')))
      }
      const sha = (await git(['rev-parse', ref])).stdout.trim()
      const listing = (await git(['ls-tree', '-r', '-l', '-z', ref])).stdout.split('\0').filter(Boolean)
      const files = new Map<string, string>()
      const skipped: Array<{ path: string; reason: string }> = []
      for (const entry of listing) {
        const tab = entry.indexOf('\t')
        const [mode, type, object, size] = entry.slice(0, tab).split(/\s+/)
        const file = entry.slice(tab + 1)
        if (type !== 'blob') { skipped.push({ path: file, reason: 'submodule' }); continue }
        if (mode === '120000') { skipped.push({ path: file, reason: 'symbolic link' }); continue }
        if (!safePath(file)) { skipped.push({ path: file, reason: 'unsafe path' }); continue }
        if (Number(size) > MAX_IMPORT_BYTES) { skipped.push({ path: file, reason: 'larger than 1 MB' }); continue }
        const text = (await git(['cat-file', 'blob', object!])).stdout
        // NUL bytes or undecodable sequences mean binary content, which belongs in Git, not a live document.
        if (text.includes('\0') || text.includes('\uFFFD')) { skipped.push({ path: file, reason: 'binary' }); continue }
        files.set(file, text)
      }
      return { sha, files, skipped }
    } catch (error) {
      if (error instanceof GitError) throw error
      throw new GitError(redact((error as Error).message), redact(log.join('')))
    }
  }

  /** Opens the pull request, or returns the one already open for this branch. */
  private async pullRequest(target: GitTarget, request: GitRequest, log: string[]): Promise<{ prUrl: string; prNumber: number }> {
    const api = `${this.githubApi.replace(/\/$/, '')}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls`
    const headers = {
      Authorization: `Bearer ${target.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'converge-worker',
    }
    const created = await fetch(api, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: request.title ?? request.message, head: request.branch, base: target.defaultBranch, body: request.body ?? '' }),
      signal: AbortSignal.timeout(30_000),
    })
    if (created.ok) {
      const pr = (await created.json()) as { html_url: string; number: number }
      log.push(`opened pull request #${pr.number}\n`)
      return { prUrl: pr.html_url, prNumber: pr.number }
    }
    if (created.status === 422) {
      const existing = await fetch(`${api}?state=open&head=${encodeURIComponent(`${target.owner}:${request.branch}`)}`, {
        headers, signal: AbortSignal.timeout(30_000),
      })
      const open = existing.ok ? ((await existing.json()) as Array<{ html_url: string; number: number }>) : []
      if (open[0]) {
        log.push(`pull request #${open[0].number} is already open; its branch was updated\n`)
        return { prUrl: open[0].html_url, prNumber: open[0].number }
      }
    }
    const detail = await created.text().catch(() => '')
    throw new GitError(`GitHub refused the pull request (${created.status})`, `${log.join('')}${detail.slice(0, 500)}\n`)
  }

  private async prepare() {
    await mkdir(this.root, { recursive: true })
    // Answers Git's username and password prompts from the environment of that one git process.
    await writeFile(this.askpass, '#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *) echo "$CONVERGE_GIT_TOKEN" ;;\nesac\n')
    await chmod(this.askpass, 0o700)
  }

  private git(dir: string, args: string[], token: string, author: { name: string; email: string }, log: string[], redact: (s: string) => string, allowFailure: boolean) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('git', [...SAFE_CONFIG, ...args], {
        cwd: dir,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: this.root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          // Workspace paths are file names, never patterns: "*.ts" in a pathspec means that one file.
          GIT_LITERAL_PATHSPECS: '1',
          GIT_ASKPASS: this.askpass,
          CONVERGE_GIT_TOKEN: token,
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: 'Converge',
          GIT_COMMITTER_EMAIL: 'converge@users.noreply.converge.dev',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        log.push(`$ git ${redact(args.join(' '))}\n${redact(stderr)}`)
        if (code !== 0 && !allowFailure) {
          reject(new GitError(`git ${args[0]} failed: ${redact(stderr.trim().split('\n').at(-1) ?? '')}`, redact(log.join(''))))
        } else {
          resolve({ code: code ?? 1, stdout, stderr })
        }
      })
    })
  }


  async remove(workspaceId: string) {
    await rm(path.join(this.root, workspaceId), { recursive: true, force: true })
  }
}


async function exists(file: string) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}
