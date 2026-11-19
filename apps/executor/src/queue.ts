import type pg from 'pg'
import { actionHash, allowed } from './templates.js'

export type Job = { id: string; workspaceId: string; command: string }

export type Claim =
  | { kind: 'run'; job: Job }
  | { kind: 'refused'; job: Job; reason: string }

/**
 * Takes the oldest queued job and, in the same transaction, checks its approval independently of the API
 * (design §13.7, Gate E): the command must be allowlisted, and the approval must belong to the same
 * workspace, be APPROVED and unused, and carry the hash of exactly this action, recomputed here. A valid
 * approval is marked used as the job is claimed, so it can authorize one run only. Anything else marks the job
 * FAILED without running it.
 */
export async function claimNext(db: pg.Pool): Promise<Claim | null> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const { rows } = await client.query<{ id: string; workspace_id: string; command: string; approval_id: string }>(`
      select id, workspace_id, command, approval_id from jobs
      where status = 'QUEUED' order by created_at
      for update skip locked limit 1`)
    const row = rows[0]
    if (!row) {
      await client.query('commit')
      return null
    }
    const job: Job = { id: row.id, workspaceId: row.workspace_id, command: row.command }
    const approval = (await client.query<{ workspace_id: string; status: string; used_at: Date | null; action_hash: string; command: string }>(`
      select workspace_id, status, used_at, action_hash, action->>'command' as command
      from approvals where id = $1 for update`, [row.approval_id])).rows[0]

    let reason: string | null = null
    if (!allowed(job.command)) reason = 'the command is not on the executor allowlist'
    else if (!approval) reason = 'there is no approval for this job'
    else if (approval.workspace_id !== job.workspaceId) reason = 'the approval belongs to another workspace'
    else if (approval.status !== 'APPROVED') reason = `the approval is ${approval.status.toLowerCase()}`
    else if (approval.used_at !== null) reason = 'the approval was already used'
    else if (approval.action_hash !== actionHash(job.workspaceId, job.command) || approval.command !== job.command) {
      reason = 'the command does not match what was approved'
    }

    if (reason) {
      await client.query(
        `update jobs set status = 'FAILED', error = $2, ended_at = now() where id = $1`,
        [job.id, `Refused by the executor: ${reason}.`],
      )
      await client.query('commit')
      return { kind: 'refused', job, reason }
    }
    await client.query(`update approvals set used_at = now() where id = $1`, [row.approval_id])
    await client.query(
      `update jobs set status = 'RUNNING', started_at = now(), heartbeat_at = now() where id = $1`,
      [job.id],
    )
    await client.query('commit')
    return { kind: 'run', job }
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** The stored text of every live file in the workspace (design §11.2); folders are implied by paths. */
export async function workspaceFiles(db: pg.Pool, workspaceId: string, maxBytes: number): Promise<Map<string, string>> {
  const { rows } = await db.query<{ path: string; text_content: string }>(`
    select f.path, d.text_content from files f join documents d on d.file_id = f.id
    where f.workspace_id = $1 and f.kind = 'FILE' and f.deleted_at is null order by f.path`, [workspaceId])
  let total = 0
  const files = new Map<string, string>()
  for (const { path, text_content } of rows) {
    // Paths come from the file tree, which never contains "..", but a sandbox input is checked anyway.
    if (path.split('/').some((part) => part === '..' || part === '' || part === '.')) continue
    total += Buffer.byteLength(text_content, 'utf8')
    if (total > maxBytes) throw new Error(`The workspace files exceed ${maxBytes} bytes`)
    files.set(path, text_content)
  }
  return files
}

/**
 * After a crash, jobs left RUNNING are not retried: whatever they did may or may not have happened, so they
 * become OUTCOME_UNKNOWN and a person records the outcome (design §13.12). One executor runs at a time.
 */
export async function markInterrupted(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`
    update jobs set status = 'OUTCOME_UNKNOWN', ended_at = now(),
        error = 'The executor stopped while this job was running; check its output and record what happened.'
    where status = 'RUNNING' returning id`)
  return rows.map((r) => r.id)
}
