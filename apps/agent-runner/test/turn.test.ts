import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { revertTurn } from '../src/edits.js'
import { FakeModel } from '../src/testing/fakeModel.js'
import { runTurn, type TurnRequest } from '../src/turn.js'
import { MemoryLedger, MemoryWorkspace } from './memory.js'

let model: FakeModel
let baseURL: string

beforeEach(async () => {
  model = new FakeModel()
  baseURL = await model.start()
})

afterEach(async () => {
  await model.stop()
})

function request(prompt: string, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    turnId: 'turn-1',
    workspaceId: 'ws-1',
    sponsor: { id: 'user-asha', name: 'Asha' },
    apiKey: 'sk-ant-test-asha',
    model: 'claude-opus-5-5',
    effort: 'high',
    prompt,
    history: [],
    costCapMicros: 1_000_000,
    ...overrides,
  }
}

const tool = (name: string, input: object) => `@tool ${name} ${JSON.stringify(input)}`

async function run(
  workspace: MemoryWorkspace,
  prompt: string,
  overrides: Partial<TurnRequest> = {},
  signal = new AbortController().signal,
  takeGuidance?: () => string[],
) {
  const ledger = new MemoryLedger()
  const status = await runTurn(request(prompt, overrides), {
    workspace, ledger, signal, typing: { chunk: 3, delayMs: 1 }, baseURL, fallbacks: true, takeGuidance,
  })
  return { status, ledger }
}

describe('an agent turn', () => {
  it('reads and edits a live document, sending the sponsor key and the documented request shape', async () => {
    const workspace = new MemoryWorkspace()
    workspace.add('src/signup.ts', 'export function signup(user) {\n  save(user)\n}\n')

    const { status, ledger } = await run(workspace, [
      'Add validation.',
      tool('read_file', { path: 'src/signup.ts' }),
      tool('edit_file', { path: 'src/signup.ts', old_string: '  save(user)', new_string: '  if (!user.email) throw new Error("email required")\n  save(user)' }),
    ].join('\n'))

    expect(status).toBe('SUCCEEDED')
    expect(workspace.hub('src/signup.ts').text()).toContain('email required')
    expect(ledger.events.filter((e) => e.kind === 'tool').map((e) => e.kind === 'tool' && e.ok)).toEqual([true, true])
    expect(ledger.events.at(-1)).toEqual({ kind: 'text', text: 'Done.' })
    expect(ledger.costMicros).toBe(3 * (1000 * 4 + 200 * 20)) // three responses at Opus 5.5 prices
    expect(workspace.cursors.some(([, index]) => index !== null)).toBe(true)
    expect(workspace.closed).toBe(true)

    const first = model.requests[0]!
    expect(first.apiKey).toBe('sk-ant-test-asha')
    expect(first.beta).toContain('server-side-fallback-2026-07-01')
    expect(first.body).toMatchObject({
      model: 'claude-opus-5-5', stream: true, fallbacks: 'default',
      thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
    })
    expect((first.body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['list_files', 'read_file', 'search', 'edit_file', 'create_file'])
    // The tool result for the read went back with line numbers.
    const second = model.requests[1]!.body.messages as Array<{ role: string; content: unknown }>
    expect(JSON.stringify(second.at(-1))).toContain('     1\\texport function signup')
  })

  it('edits alongside a person typing in the same file, and the turn can be reverted (Phase 8 exit)', async () => {
    const workspace = new MemoryWorkspace()
    const fileId = workspace.add('app.ts', 'const a = 1\nconst b = 2\n')
    const hub = workspace.hub('app.ts')
    const ben = new Y.Doc()
    hub.connect(ben)
    const benText = ben.getText('content')

    const turn = run(workspace, tool('edit_file', {
      path: 'app.ts', old_string: 'const b = 2\n', new_string: 'const b = 2\nconst written = "by the agent, typed slowly"\n',
    }))
    // Ben types at the top while the agent is typing below.
    for (const piece of ['// Ben', ' was', ' here\n']) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      benText.insert(benText.toString().indexOf('const a'), piece)
    }
    const { status, ledger } = await turn
    await hub.settle()

    expect(status).toBe('SUCCEEDED')
    expect(hub.text()).toBe('// Ben was here\nconst a = 1\nconst b = 2\nconst written = "by the agent, typed slowly"\n')
    expect(benText.toString()).toBe(hub.text())

    // Revert from what the ledger saved, as a fresh client.
    const saved = ledger.revertStates.get(fileId)!
    const doc = await workspace.open(fileId, saved.state)
    expect(revertTurn(doc.getText('content'), saved.undo, 'revert')).toBe(true)
    await hub.settle()
    expect(hub.text()).toBe('// Ben was here\nconst a = 1\nconst b = 2\n')
  })

  it('answers a stale or ambiguous edit with an error the model can act on', async () => {
    const workspace = new MemoryWorkspace()
    workspace.add('x.ts', 'a\na\n')
    const { status, ledger } = await run(workspace, [
      tool('edit_file', { path: 'x.ts', old_string: 'a', new_string: 'b' }),
      tool('edit_file', { path: 'x.ts', old_string: 'zzz', new_string: 'b' }),
      tool('edit_file', { path: 'x.ts', old_string: 'a', new_string: 'b', replace_all: true }),
      tool('read_file', { path: 'missing.ts' }),
      tool('edit_file', { path: 'x.ts', old_string: 42 }),
    ].join('\n'))

    expect(status).toBe('SUCCEEDED')
    expect(ledger.events.filter((e) => e.kind === 'tool').map((e) => e.kind === 'tool' && e.summary)).toEqual([
      'edit_file: old_string occurs 2 times in x.ts; add surrounding lines or set replace_all.',
      'edit_file: old_string was not found in x.ts. Read the file again; a teammate may have changed it.',
      'edited x.ts',
      'read_file: No file at missing.ts. Use list_files to see what exists.',
      'edit_file: invalid input',
    ])
    expect(workspace.hub('x.ts').text()).toBe('b\nb\n')
  })

  it('creates files and searches', async () => {
    const workspace = new MemoryWorkspace()
    workspace.add('README.md', '# Project\nTODO: write docs\n')
    const { status, ledger } = await run(workspace, [
      tool('search', { query: 'TODO' }),
      tool('create_file', { path: 'docs/guide.md', content: '# Guide\n' }),
      tool('create_file', { path: 'README.md', content: 'again' }),
    ].join('\n'))
    expect(status).toBe('SUCCEEDED')
    expect(workspace.hub('docs/guide.md').text()).toBe('# Guide\n')
    const results = JSON.stringify(model.requests[1]!.body.messages)
    expect(results).toContain('README.md:2: TODO: write docs')
    expect(ledger.events.filter((e) => e.kind === 'tool').at(-1)).toMatchObject({ ok: false })
  })

  it('stops on a refusal without running tools', async () => {
    const workspace = new MemoryWorkspace()
    const { status, ledger } = await run(workspace, '@refuse')
    expect(status).toBe('REFUSED')
    expect(ledger.finished).toEqual({ status: 'REFUSED', error: 'Scripted refusal.' })
  })

  it('stops at the cost cap', async () => {
    const workspace = new MemoryWorkspace()
    workspace.add('a.txt', 'x')
    const { status } = await run(workspace, [tool('list_files', {}), tool('list_files', {}), tool('list_files', {})].join('\n'), {
      costCapMicros: 10_000,
    })
    expect(status).toBe('BUDGET_EXCEEDED')
    expect(model.requests.length).toBe(2)
  })

  it('can be cancelled during a model request', async () => {
    const workspace = new MemoryWorkspace()
    const controller = new AbortController()
    const turn = run(workspace, '@slow 5000\n' + tool('list_files', {}), {}, controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    const { status, ledger } = await turn
    expect(status).toBe('CANCELLED')
    expect(ledger.finished?.status).toBe('CANCELLED')
  })

  it('reports a rejected key without leaking it', async () => {
    const workspace = new MemoryWorkspace()
    const { status, ledger } = await run(workspace, 'hello', { apiKey: 'sk-ant-invalid' })
    expect(status).toBe('FAILED')
    expect(ledger.finished?.error).toBe('The Anthropic API key was rejected. Update it in agent settings.')
    expect(ledger.finished?.code).toBe('KEY_REJECTED') // so a session it drives can be taken over
  })

  it('carries earlier exchanges in the lane as history', async () => {
    const workspace = new MemoryWorkspace()
    await run(workspace, 'second question', { history: [{ prompt: 'first question', reply: 'first answer' }] })
    const messages = model.requests[0]!.body.messages as Array<{ role: string; content: string }>
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[2]!.content).toBe('Asha asks:\n\nsecond question')
  })

  it('works the session plan: proposes steps for its sponsor and only moves those (design §13.9)', async () => {
    const workspace = new MemoryWorkspace()
    workspace.steps.push({ position: 1, title: 'Review copy', ownerName: 'Ben', status: 'TODO' })
    const session = { id: '7d6c1c3a-1111-4222-8333-944455556666', task: 'Ship the signup form' }
    const { status, ledger } = await run(workspace, [
      tool('get_plan', {}),
      tool('propose_plan', { steps: ['Add validation', 'Write tests'] }),
      tool('update_step', { position: 2, status: 'DONE' }),
      tool('update_step', { position: 1, status: 'DONE' }),
    ].join('\n'), { session })

    expect(status).toBe('SUCCEEDED')
    expect(workspace.steps.map((s) => `${s.position} ${s.status} ${s.ownerName}`)).toEqual(['1 TODO Ben', '2 DONE Asha', '3 TODO Asha'])
    expect(ledger.events.filter((e) => e.kind === 'tool').map((e) => e.kind === 'tool' && e.ok)).toEqual([true, true, true, false])
    const first = model.requests[0]!.body
    expect((first.tools as Array<{ name: string }>).map((x) => x.name)).toContain('propose_plan')
    expect(JSON.stringify(first.messages)).toContain('Session task: Ship the signup form')
    expect(JSON.stringify(model.requests[1]!.body.messages)).toContain('1. [TODO] Review copy (Ben)')
  })

  it('offers plan tools only inside a session', async () => {
    await run(new MemoryWorkspace(), 'hello')
    expect((model.requests[0]!.body.tools as Array<{ name: string }>).map((x) => x.name)).not.toContain('get_plan')
  })

  it("passes the sponsor's guidance to the model between tool calls, and late guidance keeps the turn going", async () => {
    const workspace = new MemoryWorkspace()
    workspace.add('a.txt', 'x')
    const queue = ['focus on the email check']
    let calls = 0
    const take = () => {
      calls++
      // The first guidance arrives during the first tool call; more arrives as the model is finishing.
      if (calls === 1) return queue.splice(0)
      if (calls === 2) return ['also add a test']
      return []
    }
    const { status } = await run(workspace, tool('list_files', {}), {}, new AbortController().signal, take)
    expect(status).toBe('SUCCEEDED')
    const second = JSON.stringify(model.requests[1]!.body.messages)
    expect(second).toContain('Guidance from Asha while you work: focus on the email check')
    expect(JSON.stringify(model.requests.at(-1)!.body.messages)).toContain('also add a test')
  })
})
