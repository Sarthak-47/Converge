import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { actionHash, allowed, argv } from '../src/templates.js'

const cases = JSON.parse(readFileSync(path.join(import.meta.dirname, 'allowlist-cases.json'), 'utf8')) as {
  allowed: string[]
  refused: string[]
}

describe('the executor allowlist (design §11.5)', () => {
  it.each(cases.allowed)('allows %j', (command) => expect(allowed(command)).toBe(true))
  it.each(cases.refused)('refuses %j', (command) => expect(allowed(command)).toBe(false))

  it('runs commands as argv, never through a shell', () => {
    expect(argv('node --test a.test.js b.test.js')).toEqual(['node', '--test', 'a.test.js', 'b.test.js'])
  })

  it('hashes the canonical action exactly as the API does', () => {
    const workspaceId = '0f8fad5b-d9cb-469f-a165-70867728950e'
    const canonical = `{"command":"node --test tests/math.test.js","kind":"run_command","workspaceId":"${workspaceId}"}`
    expect(actionHash(workspaceId, 'node --test tests/math.test.js'))
      .toBe(createHash('sha256').update(canonical).digest('hex'))
  })
})
