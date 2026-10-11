/** What should happen to someone's open document connections after their workspace role changed. */
export type RevokeAction = 'read-only' | 'read-write' | 'close'

export const REVOKE_ACTIONS: readonly RevokeAction[] = ['read-only', 'read-write', 'close']

/** The parts of a Hocuspocus connection this needs; kept minimal so it can be tested without a server. */
export type LiveConnection = {
  context: { userId?: string; workspaceId?: string } | undefined
  readOnly: boolean
  close(event?: { code: number; reason: string }): void
}

/** Close code the web client recognises as "your access to this workspace was removed". */
export const ACCESS_REMOVED = { code: 4403, reason: 'Workspace access removed' }

/**
 * Applies a role change to one person's connections in one workspace (FR-18). A downgrade takes effect on
 * the very next update the client sends: Hocuspocus drops document updates from read-only connections.
 * Returns how many connections were affected.
 */
export function revokeConnections(
  connections: Iterable<LiveConnection>,
  userId: string,
  workspaceId: string,
  action: RevokeAction,
): number {
  let affected = 0
  for (const connection of connections) {
    if (connection.context?.userId !== userId || connection.context?.workspaceId !== workspaceId) continue
    affected++
    if (action === 'close') connection.close(ACCESS_REMOVED)
    else connection.readOnly = action === 'read-only'
  }
  return affected
}
