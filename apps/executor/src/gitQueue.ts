import type pg from 'pg'

export type GitOperation = {
  id: string
  workspaceId: string
  type: 'PULL_REQUEST' | 'PUSH_BRANCH' | 'PULL'
  params: { branch: string; message: string; title?: string; body?: string }
  requester: { id: string; name: string }
  repository: { remoteUrl: string; defaultBranch: string; owner: string; repo: string; credential: Buffer } | null
}

/** Takes the oldest queued Git operation and marks it running (one worker, one operation at a time). */
export async function claimGitOperation(db: pg.Pool): Promise<GitOperation | null> {
  const client = await db.connect()
  try {
    await client.query('begin')
    const { rows } = await client.query<{
      id: string; workspace_id: string; type: GitOperation['type']; params: GitOperation['params']
      requested_by: string; display_name: string
      remote_url: string | null; default_branch: string; owner: string; repo: string; credential: Buffer | null
    }>(`
      select o.id, o.workspace_id, o.type, o.params, o.requested_by, u.display_name,
             g.remote_url, g.default_branch, g.owner, g.repo, g.credential
      from git_operations o join users u on u.id = o.requested_by
      left join git_repositories g on g.workspace_id = o.workspace_id
      where o.status = 'QUEUED' order by o.created_at
      for update of o skip locked limit 1`)
    const row = rows[0]
    if (!row) {
      await client.query('commit')
      return null
    }
    await client.query(`update git_operations set status = 'RUNNING', started_at = now() where id = $1`, [row.id])
    await client.query('commit')
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      type: row.type,
      params: row.params,
      requester: { id: row.requested_by, name: row.display_name },
      repository: row.remote_url && row.credential
        ? { remoteUrl: row.remote_url, defaultBranch: row.default_branch, owner: row.owner, repo: row.repo, credential: row.credential }
        : null,
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export async function finishGitOperation(
  db: pg.Pool,
  id: string,
  outcome: { status: 'SUCCEEDED' | 'FAILED'; result?: object; error?: string; log: string },
) {
  await db.query(
    `update git_operations set status = $2, result = $3, error = $4, log = $5, ended_at = now()
     where id = $1 and status = 'RUNNING'`,
    [id, outcome.status, outcome.result ? JSON.stringify(outcome.result) : null, outcome.error ?? null, outcome.log.slice(-20_000)],
  )
}

/**
 * Operations left RUNNING by a crash are not retried automatically: a push may or may not have reached the
 * remote. They fail with a note; running them again is safe because the branch is rebuilt and force-pushed.
 */
export async function failInterruptedGitOperations(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`
    update git_operations set status = 'FAILED', ended_at = now(),
        error = 'The worker stopped during this operation; check the branch on GitHub and run it again if needed.'
    where status = 'RUNNING' returning id`)
  return rows.map((r) => r.id)
}
