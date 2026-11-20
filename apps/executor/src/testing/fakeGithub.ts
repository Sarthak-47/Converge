import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

/**
 * A stand-in for GitHub, for tests and the end-to-end stack only: real Git over smart HTTP (served by
 * `git http-backend`, so pushes and fetches are genuine) and the one REST endpoint Converge uses, opening a
 * pull request. Every request must carry the configured token, as GitHub would require.
 *
 *   /{owner}/{repo}.git/...              Git smart HTTP
 *   POST /api/repos/{owner}/{repo}/pulls  open a pull request
 *   GET  /api/repos/{owner}/{repo}/pulls  list pull requests (?head=owner:branch)
 *   POST /__test/repos                    create a repository with files on its default branch
 *   GET  /__test/pulls                    every pull request opened, for assertions
 */
export type PullRequest = { number: number; owner: string; repo: string; title: string; head: string; base: string; body: string; html_url: string }

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).toString()

export class FakeGithub {
  readonly pulls: PullRequest[] = []
  private server: Server | null = null
  private baseUrl = ''

  constructor(readonly root: string, readonly token: string) {
    mkdirSync(root, { recursive: true })
  }

  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res).catch((error: Error) => {
      if (!res.headersSent) res.writeHead(500).end(error.message)
    }))
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve))
    const address = this.server.address() as AddressInfo
    this.baseUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`
    return this.baseUrl
  }

  async stop() {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }

  /** Creates owner/repo with the given files committed on `branch`. */
  createRepo(owner: string, repo: string, files: Record<string, string>, branch = 'main') {
    const bare = path.join(this.root, owner, `${repo}.git`)
    rmSync(bare, { recursive: true, force: true })
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '-q', '--bare', `--initial-branch=${branch}`])
    git(bare, ['config', 'http.receivepack', 'true'])
    if (Object.keys(files).length === 0) return
    const work = mkdtempSync(path.join(this.root, 'seed-'))
    try {
      git(work, ['init', '-q', `--initial-branch=${branch}`])
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(work, file)), { recursive: true })
        writeFileSync(path.join(work, file), text)
      }
      git(work, ['add', '-A'])
      git(work, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-q', '-m', 'Initial commit'])
      git(work, ['push', '-q', bare, `HEAD:refs/heads/${branch}`])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  /** Reads a file as committed on a branch, for assertions. */
  fileAt(owner: string, repo: string, branch: string, file: string): string {
    return git(path.join(this.root, owner, `${repo}.git`), ['show', `${branch}:${file}`])
  }

  /** Author and subject of a branch's head commit. */
  headCommit(owner: string, repo: string, branch: string): { author: string; email: string; subject: string; files: string[] } {
    const bare = path.join(this.root, owner, `${repo}.git`)
    const [author = '', email = '', subject = ''] = git(bare, ['log', '-1', '--format=%an%n%ae%n%s', branch]).split('\n')
    const files = git(bare, ['ls-tree', '-r', '--name-only', branch]).split('\n').filter(Boolean)
    return { author, email, subject, files }
  }

  private authorized(req: IncomingMessage) {
    const header = req.headers.authorization ?? ''
    if (header === `Bearer ${this.token}` || header === `token ${this.token}`) return true
    if (header.startsWith('Basic ')) {
      const [, password] = Buffer.from(header.slice(6), 'base64').toString().split(':')
      return password === this.token
    }
    return false
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://fake')
    const json = (status: number, value: unknown) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value))

    if (url.pathname === '/health') return json(200, { status: 'UP' })
    if (url.pathname === '/__test/pulls') return json(200, this.pulls)
    if (url.pathname === '/__test/repos' && req.method === 'POST') {
      const { owner, repo, files, branch } = JSON.parse((await this.body(req)).toString()) as { owner: string; repo: string; files: Record<string, string>; branch?: string }
      this.createRepo(owner, repo, files, branch)
      return json(201, { cloneUrl: `${this.baseUrl}/${owner}/${repo}.git` })
    }
    const head = /^\/__test\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.exec(url.pathname)
    if (head && req.method === 'GET') {
      return json(200, this.headCommit(head[1]!, head[2]!, decodeURIComponent(head[3]!)))
    }

    if (!this.authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake-github"', 'Content-Type': 'application/json' })
      return res.end('{"message":"Requires authentication"}')
    }

    const pulls = /^\/api\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(url.pathname)
    if (pulls) {
      const [, owner, repo] = pulls as unknown as [string, string, string]
      if (req.method === 'GET') {
        const wanted = url.searchParams.get('head')
        return json(200, this.pulls.filter((p) => p.owner === owner && p.repo === repo && (!wanted || `${owner}:${p.head}` === wanted)))
      }
      const input = JSON.parse((await this.body(req)).toString()) as { title: string; head: string; base: string; body?: string }
      if (this.pulls.some((p) => p.owner === owner && p.repo === repo && p.head === input.head)) {
        return json(422, { message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${owner}:${input.head}.` }] })
      }
      const number = this.pulls.length + 1
      const pr = { number, owner, repo, title: input.title, head: input.head, base: input.base, body: input.body ?? '', html_url: `${this.baseUrl}/${owner}/${repo}/pull/${number}` }
      this.pulls.push(pr)
      return json(201, pr)
    }

    if (/^\/[^/]+\/[^/]+\.git\//.test(url.pathname)) return this.gitHttp(req, res, url)
    return json(404, { message: 'Not Found' })
  }

  /** Runs `git http-backend` as a CGI program for one request. */
  private async gitHttp(req: IncomingMessage, res: ServerResponse, url: URL) {
    const input = await this.body(req)
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: 'x-access-token',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(input.length),
        HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
        GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(input)
    const output: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    await new Promise((resolve) => child.on('close', resolve))
    const raw = Buffer.concat(output)
    const split = raw.indexOf('\r\n\r\n')
    const headerText = raw.subarray(0, split).toString()
    let status = 200
    const headers: Record<string, string> = {}
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':')
      const name = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
      else if (name) headers[name] = value
    }
    res.writeHead(status, headers).end(raw.subarray(split + 4))
  }
}
