import type { AuditEvent } from '../api.ts'

/** One audit event as a short sentence after the actor's name, e.g. "archived the workspace". */
export function describeActivity(event: AuditEvent): string {
  let meta: Record<string, unknown> = {}
  try {
    meta = JSON.parse(event.metadata) as Record<string, unknown>
  } catch {
    // Unreadable metadata: describe the action alone.
  }
  const role = typeof meta.role === 'string' ? meta.role.toLowerCase() : null
  switch (event.action) {
    case 'workspace.renamed': return `renamed the workspace to “${String(meta.name ?? '')}”`
    case 'workspace.archived': return 'archived the workspace'
    case 'workspace.unarchived': return 'unarchived the workspace'
    case 'member.invited': return `invited ${String(meta.email ?? 'someone')}${role ? ` as ${role}` : ''}`
    case 'member.added': return `added a member${role ? ` as ${role}` : ''}`
    case 'member.joined': return `joined${role ? ` as ${role}` : ''}`
    case 'member.role_changed': return `changed a member's role${role ? ` to ${role}` : ''}`
    case 'member.removed': return 'removed a member'
    case 'member.left': return 'left the workspace'
    case 'member.invitation_cancelled': return 'cancelled an invitation'
    case 'git.connected': return `connected ${String(meta.remote ?? 'a repository')}`
    case 'git.disconnected': return 'disconnected the repository'
    case 'git.webhook_enabled': return 'turned on automatic import'
    case 'git.webhook_disabled': return 'turned off automatic import'
    case 'git.pull': return 'imported the repository'
    case 'git.push': return `pushed ${String(meta.branch ?? 'a branch')}`
    case 'git.pull_request': return `opened a pull request from ${String(meta.branch ?? 'a branch')}`
    case 'file.restored': return `restored a file to version ${String(meta.version ?? '?')}`
    case 'job.requested': return `asked to run ${String(meta.command ?? 'a command')}`
    case 'approval.approved': return 'approved a command'
    case 'approval.denied': return 'denied a command'
    case 'job.outcome_recorded': return `recorded a job's outcome (${String(meta.outcome ?? '').toLowerCase()})`
    case 'session.created': return 'started a session'
    case 'session.taken_over': return 'took over a session'
    case 'session.handed_off': return 'handed off a session'
    case 'session.finished': return 'finished a session'
    default: return event.action.replace(/[._]/g, ' ')
  }
}
