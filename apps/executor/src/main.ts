import Docker from 'dockerode'
import pg from 'pg'
import { config } from './config.js'
import { GitError, GitWorker } from './git.js'
import { claimGitOperation, failInterruptedGitOperations, finishGitOperation, type GitOperation } from './gitQueue.js'
import { claimNext, markInterrupted, workspaceFiles, type Job } from './queue.js'
import { openSealed } from './secrets.js'
import { Reporter } from './reporter.js'
import { Sandbox } from './sandbox.js'
import { argv } from './templates.js'

function log(level: 'INFO' | 'WARN' | 'ERROR', event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'executor', event, ...fields }))
}

const db = new pg.Pool({ connectionString: config.databaseUrl, max: 4 })
const sandbox = new Sandbox(new Docker(), config)
const git = new GitWorker(config.gitRoot, config.githubApi)
let stopping = false

async function run(job: Job) {
  const reporter = new Reporter(config.apiUrl, config.internalToken, job.id)
  await reporter.notify().catch(() => undefined)
  try {
    const files = await workspaceFiles(db, job.workspaceId, config.maxFilesBytes)
    reporter.output('system', `$ ${job.command}\n`)
    const result = await sandbox.run({ jobId: job.id, files, argv: argv(job.command), onOutput: (s, c) => reporter.output(s, c) })
    const status = result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED'
    await reporter.status(status, {
      exitCode: result.exitCode,
      error: result.timedOut ? `Timed out after ${Math.round(config.timeoutMs / 1000)} s` : undefined,
    })
    log('INFO', 'JOB_FINISHED', { jobId: job.id, status, exitCode: result.exitCode, timedOut: result.timedOut })
  } catch (error) {
    log('ERROR', 'JOB_FAILED', { jobId: job.id, message: (error as Error).message })
    await reporter.status('FAILED', { error: 'The job could not be run in the sandbox.' }).catch(() => undefined)
  }
}

async function notifyGit(id: string) {
  await fetch(`${config.apiUrl.replace(/\/$/, '')}/internal/git/operations/${id}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.internalToken },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
}

/** One Git operation (design §10): the workspace's stored text, committed on a branch, pushed, maybe a PR. */
async function runGit(op: GitOperation) {
  await notifyGit(op.id)
  try {
    if (!op.repository) throw new GitError('The workspace is no longer connected to a repository', '')
    const token = openSealed(op.repository.credential, `git-credential:${op.workspaceId}`, config.secretsKey)
    if (op.type === 'PULL') {
      const result = await importBranch(op, { ...op.repository, token })
      await finishGitOperation(db, op.id, { status: 'SUCCEEDED', result, log: '' })
      log('INFO', 'GIT_OPERATION_SUCCEEDED', { operationId: op.id, type: op.type, ...result, skipped: result.skipped.length })
      await notifyGit(op.id)
      return
    }
    const files = await workspaceFiles(db, op.workspaceId, config.maxFilesBytes)
    const result = await git.run(op.workspaceId, { ...op.repository, token }, {
      type: op.type,
      branch: op.params.branch,
      message: op.params.message,
      title: op.params.title,
      body: op.params.body,
      // The person who asked is the author; a no-reply address keeps their email out of the remote.
      author: { name: op.requester.name, email: `${op.requester.id}@users.noreply.converge.dev` },
      files,
    })
    await finishGitOperation(db, op.id, { status: 'SUCCEEDED', result, log: '' })
    log('INFO', 'GIT_OPERATION_SUCCEEDED', { operationId: op.id, type: op.type, branch: result.branch, sha: result.sha })
  } catch (error) {
    const message = error instanceof GitError ? error.message : 'The Git operation failed.'
    await finishGitOperation(db, op.id, { status: 'FAILED', error: message, log: error instanceof GitError ? error.log : '' })
    log('WARN', 'GIT_OPERATION_FAILED', { operationId: op.id, message })
  }
  await notifyGit(op.id)
}

/**
 * Imports the default branch (design §10.2): the files go to the API in batches, which creates the new ones
 * and merges changes into existing documents as external edits, as the person who asked.
 */
async function importBranch(op: GitOperation, target: Parameters<GitWorker['readBranch']>[1]) {
  const contents = await git.readBranch(op.workspaceId, target)
  const totals = { created: 0, updated: 0, unchanged: 0 }
  const refused: string[] = []
  const entries = [...contents.files]
  for (let i = 0; i < entries.length; i += 100) {
    const batch = entries.slice(i, i + 100).map(([path, text]) => ({ path, text }))
    const response = await fetch(`${config.apiUrl.replace(/\/$/, '')}/internal/git/operations/${op.id}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': config.internalToken },
      body: JSON.stringify({ files: batch }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) throw new GitError(`The API refused the import (${response.status})`, await response.text().catch(() => ''))
    const result = (await response.json()) as { created: number; updated: number; unchanged: number; refused: string[] }
    totals.created += result.created
    totals.updated += result.updated
    totals.unchanged += result.unchanged
    refused.push(...result.refused)
  }
  return {
    branch: op.params.branch,
    sha: contents.sha,
    changedFiles: totals.created + totals.updated,
    ...totals,
    skipped: [...contents.skipped.map((s) => `${s.path}: ${s.reason}`), ...refused].slice(0, 200),
  }
}

async function gitLoop() {
  while (!stopping) {
    try {
      const op = await claimGitOperation(db)
      if (op) await runGit(op)
      else await new Promise((resolve) => setTimeout(resolve, config.pollMs))
    } catch (error) {
      log('ERROR', 'GIT_QUEUE_ERROR', { message: (error as Error).message })
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }
}

async function loop() {
  while (!stopping) {
    try {
      const claim = await claimNext(db)
      if (!claim) {
        await new Promise((resolve) => setTimeout(resolve, config.pollMs))
        continue
      }
      if (claim.kind === 'refused') {
        log('WARN', 'JOB_REFUSED', { jobId: claim.job.id, reason: claim.reason })
        await new Reporter(config.apiUrl, config.internalToken, claim.job.id).notify().catch(() => undefined)
        continue
      }
      log('INFO', 'JOB_STARTED', { jobId: claim.job.id, command: claim.job.command })
      await run(claim.job)
    } catch (error) {
      log('ERROR', 'QUEUE_ERROR', { message: (error as Error).message })
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }
}

const interrupted = await markInterrupted(db)
for (const id of interrupted) await new Reporter(config.apiUrl, config.internalToken, id).notify().catch(() => undefined)
for (const id of await failInterruptedGitOperations(db)) await notifyGit(id)
const removed = await sandbox.removeLeftovers()
await sandbox.prepare()
log('INFO', 'EXECUTOR_STARTED', { image: config.image, runtime: config.runtime ?? 'default', interrupted: interrupted.length, removedContainers: removed })
const done = Promise.all([loop(), gitLoop()])

const shutdown = () => {
  stopping = true
  void done.finally(() => db.end().finally(() => process.exit(0)))
  setTimeout(() => process.exit(0), 15_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
