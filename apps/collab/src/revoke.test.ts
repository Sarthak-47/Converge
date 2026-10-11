import { describe, expect, it, vi } from 'vitest'
import { ACCESS_REMOVED, revokeConnections, type LiveConnection } from './revoke.js'

function connection(userId: string, workspaceId: string, readOnly = false): LiveConnection & { close: ReturnType<typeof vi.fn> } {
  return { context: { userId, workspaceId }, readOnly, close: vi.fn() }
}

describe('revokeConnections', () => {
  it('downgrades only the named person in the named workspace', () => {
    const target = connection('ben', 'w1')
    const otherWorkspace = connection('ben', 'w2')
    const otherPerson = connection('asha', 'w1')

    const affected = revokeConnections([target, otherWorkspace, otherPerson], 'ben', 'w1', 'read-only')

    expect(affected).toBe(1)
    expect(target.readOnly).toBe(true)
    expect(otherWorkspace.readOnly).toBe(false)
    expect(otherPerson.readOnly).toBe(false)
  })

  it('restores write access after a promotion', () => {
    const target = connection('ben', 'w1', true)
    revokeConnections([target], 'ben', 'w1', 'read-write')
    expect(target.readOnly).toBe(false)
  })

  it('closes every tab of a removed member with the access-removed code', () => {
    const tabs = [connection('ben', 'w1'), connection('ben', 'w1')]
    expect(revokeConnections(tabs, 'ben', 'w1', 'close')).toBe(2)
    tabs.forEach((tab) => expect(tab.close).toHaveBeenCalledWith(ACCESS_REMOVED))
  })

  it('ignores connections without a user context, such as server-side direct connections', () => {
    const direct: LiveConnection = { context: undefined, readOnly: false, close: vi.fn() }
    expect(revokeConnections([direct], 'ben', 'w1', 'close')).toBe(0)
  })
})
