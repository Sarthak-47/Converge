import Docker from 'dockerode'
import pg from 'pg'
import { config } from './config.js'
import { claimNext, markInterrupted, workspaceFiles, type Job } from './queue.js'
import { Reporter } from './reporter.js'
import { Sandbox } from './sandbox.js'
import { argv } from './templates.js'

function log(level: 'INFO' | 'WARN' | 'ERROR', event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'executor', event, ...fields }))
}

const db = new pg.Pool({ connectionString: config.databaseUrl, max: 4 })
const sandbox = new Sandbox(new Docker(), config)
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
const removed = await sandbox.removeLeftovers()
await sandbox.prepare()
log('INFO', 'EXECUTOR_STARTED', { image: config.image, runtime: config.runtime ?? 'default', interrupted: interrupted.length, removedContainers: removed })
const done = loop()

const shutdown = () => {
  stopping = true
  void done.finally(() => db.end().finally(() => process.exit(0)))
  setTimeout(() => process.exit(0), 15_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
