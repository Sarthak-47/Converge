import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimNext, markInterrupted, workspaceFiles } from '../src/queue.js'
import { actionHash } from '../src/templates.js'

/**
 * Gate E, enforced where it runs (design §13.7): the executor refuses any job without a matching, unused
 * approval, whatever the API or the database rows say. Needs the stack's PostgreSQL (with the API's migrations
 * applied): set EXECUTOR_TEST_DATABASE_URL, e.g. postgres://converge:converge@localhost:5432/converge.
 */
const url = process.env.EXECUTOR_TEST_DATABASE_URL
const db = url ? new pg.Pool({ connectionString: url, max: 2 }) : null

let userId: string
let workspaceId: string

async function approvedJob(command: string, overrides: { status?: string; hashFor?: string; usedAt?: boolean; workspace?: string } = {}) {
  const approvalId = randomUUID()
  const jobId = randomUUID()
  const workspace = overrides.workspace ?? workspaceId
  await db!.query(
    `insert into approvals (id, workspace_id, requested_by, action, action_hash, capabilities, status, expires_at, used_at)
     values ($1, $2, $3, $4, $5, '["execute:sandbox"]', $6, now() + interval '10 minutes', $7)`,
    [approvalId, workspace, userId, JSON.stringify({ command: overrides.hashFor ?? command, kind: 'run_command', workspaceId: workspace }),
      actionHash(workspace, overrides.hashFor ?? command), overrides.status ?? 'APPROVED', overrides.usedAt ? new Date() : null],
  )
  await db!.query(`insert into jobs (id, workspace_id, approval_id, requested_by, command) values ($1, $2, $3, $4, $5)`,
    [jobId, workspaceId, approvalId, userId, command])
  return { approvalId, jobId }
}

async function claimOnly(jobId: string) {
  // Other tests' jobs may be queued too; claim until this one comes up.
  for (let i = 0; i < 50; i++) {
    const claim = await claimNext(db!)
    if (!claim) return null
    if (claim.job.id === jobId) return claim
  }
  return null
}

describe.skipIf(!db)('claiming jobs (Gate E)', () => {
  beforeAll(async () => {
    userId = randomUUID()
    workspaceId = randomUUID()
    await db!.query(`insert into users (id, email, display_name, password_hash) values ($1, $2, 'Executor test', 'x')`, [userId, `exec-${userId}@example.test`])
    await db!.query(`insert into workspaces (id, owner_id, name, slug) values ($1, $2, 'Executor test', $3)`, [workspaceId, userId, `exec-${workspaceId}`])
    // Leave no other queued jobs that could be picked up first.
    await db!.query(`update jobs set status = 'CANCELED' where status = 'QUEUED'`)
  })

  afterAll(async () => {
    await db?.query(`delete from workspaces where id = $1`, [workspaceId])
    await db?.end()
  })

  it('runs a job whose approval matches, and uses the approval up', async () => {
    const { approvalId, jobId } = await approvedJob('npm test')
    const claim = await claimOnly(jobId)
    expect(claim?.kind).toBe('run')
    const approval = (await db!.query(`select used_at from approvals where id = $1`, [approvalId])).rows[0]
    expect(approval.used_at).not.toBeNull()
    expect((await db!.query(`select status from jobs where id = $1`, [jobId])).rows[0].status).toBe('RUNNING')
  })

  it('refuses a command altered after approval', async () => {
    const { approvalId, jobId } = await approvedJob('npm test')
    await db!.query(`update jobs set command = 'npm run evil' where id = $1`, [jobId])
    const claim = await claimOnly(jobId)
    expect(claim).toMatchObject({ kind: 'refused', reason: 'the command does not match what was approved' })
    expect((await db!.query(`select used_at from approvals where id = $1`, [approvalId])).rows[0].used_at).toBeNull()
    const job = (await db!.query(`select status, error from jobs where id = $1`, [jobId])).rows[0]
    expect(job.status).toBe('FAILED')
    expect(job.error).toContain('Refused by the executor')
  })

  it.each([
    ['a pending approval', { status: 'PENDING' }, 'the approval is pending'],
    ['a denied approval', { status: 'DENIED' }, 'the approval is denied'],
    ['an already used approval', { usedAt: true }, 'the approval was already used'],
    ['a hash for another action', { hashFor: 'npm run lint' }, 'the command does not match what was approved'],
  ])('refuses %s', async (_name, overrides, reason) => {
    const { jobId } = await approvedJob('npm test', overrides)
    expect(await claimOnly(jobId)).toMatchObject({ kind: 'refused', reason })
  })

  it('refuses a command that is not on its own allowlist, even with a matching approval', async () => {
    const { jobId } = await approvedJob('curl http://example.com')
    expect(await claimOnly(jobId)).toMatchObject({ kind: 'refused', reason: 'the command is not on the executor allowlist' })
  })

  it('marks jobs interrupted by a crash as outcome unknown instead of retrying them', async () => {
    const { jobId } = await approvedJob('npm test')
    await claimOnly(jobId)
    expect(await markInterrupted(db!)).toContain(jobId)
    expect((await db!.query(`select status from jobs where id = $1`, [jobId])).rows[0].status).toBe('OUTCOME_UNKNOWN')
    expect(await claimNext(db!)).toBeNull()
  })

  it('copies only this workspace’s live files', async () => {
    const fileId = randomUUID()
    await db!.query(`insert into files (id, workspace_id, name, kind, path) values ($1, $2, 'a.txt', 'FILE', 'src/a.txt')`, [fileId, workspaceId])
    await db!.query(`insert into documents (file_id, text_content, content_hash) values ($1, 'hello', 'h')`, [fileId])
    const files = await workspaceFiles(db!, workspaceId, 1024)
    expect([...files]).toEqual([['src/a.txt', 'hello']])
    await expect(workspaceFiles(db!, workspaceId, 2)).rejects.toThrow('exceed')
  })
})
