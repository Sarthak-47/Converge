import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

const tool = (name: string, input: object) => `@tool ${name} ${JSON.stringify(input)}`

async function run(workspace: MemoryWorkspace, prompt: string, overrides: Partial<TurnRequest>) {
  const ledger = new MemoryLedger()
  const request: TurnRequest = {
    turnId: 'turn-1',
    workspaceId: 'ws-1',
    sponsor: { id: 'user-asha', name: 'Asha' },
    apiKey: 'sk-test-openai-asha',
    provider: 'openai',
    model: 'gpt-test',
    effort: 'high',
    prompt,
    history: [],
    costCapMicros: 1_000_000,
    ...overrides,
  }
  const status = await runTurn(request, {
    workspace, ledger, signal: new AbortController().signal, typing: { chunk: 3, delayMs: 1 }, baseURL, fallbacks: true, pollMs: 5,
  })
  return { status, ledger }
}

describe('a turn on an OpenAI-compatible provider', () => {
  it('runs the same tools on the sponsor key, in the Chat Completions format', async () => {
    const workspace = new MemoryWorkspace()
    workspace.add('src/signup.ts', 'export function signup(user) {\n  save(user)\n}\n')
    const { status, ledger } = await run(workspace, [
      'Add validation.',
      tool('read_file', { path: 'src/signup.ts' }),
      tool('edit_file', { path: 'src/signup.ts', old_string: '  save(user)', new_string: '  if (!user.email) throw new Error("email required")\n  save(user)' }),
    ].join('\n'), {})

    expect(status).toBe('SUCCEEDED')
    expect(workspace.hub('src/signup.ts').text()).toContain('email required')
    expect(ledger.events.at(-1)).toEqual({ kind: 'text', text: 'Done.' })
    // No built-in price for this model, so it is charged at the deliberately high rate.
    expect(ledger.costMicros).toBe(3 * (1000 * 15 + 200 * 75))

    const first = model.requests[0]!
    expect(first.apiKey).toBe('sk-test-openai-asha')
    expect(first.body).toMatchObject({ model: 'gpt-test', stream: true, stream_options: { include_usage: true } })
    expect(first.body).not.toHaveProperty('thinking')
    const messages = first.body.messages as Array<{ role: string; content: string }>
    expect(messages[0]!.role).toBe('system')
    expect(messages[1]).toEqual({ role: 'user', content: expect.stringContaining('Asha asks:') })
    const tools = first.body.tools as Array<{ type: string; function: { name: string } }>
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'list_files' } })

    // The read's result went back as a tool message answering the call.
    const second = model.requests[1]!.body.messages as Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>
    expect(second.at(-1)!.role).toBe('tool')
    expect(second.at(-1)!.tool_call_id).toBe(second.at(-2)!.tool_calls![0]!.id)
    expect(second.at(-1)!.content).toContain('     1\texport function signup')
  })

  it('strips schema keywords Gemini rejects', async () => {
    await run(new MemoryWorkspace(), 'hello', { provider: 'gemini', model: 'gemini-test', apiKey: 'AIza-test-key-0000000000' })
    expect(JSON.stringify(model.requests[0]!.body.tools)).not.toContain('additionalProperties')
  })

  it('asks OpenRouter for its own price of each request', async () => {
    await run(new MemoryWorkspace(), 'hello', { provider: 'openrouter', model: 'meta/llama-test' })
    expect(model.requests[0]!.body).toMatchObject({ usage: { include: true } })
  })

  it('reports a rejected key by provider name, so a session can be taken over', async () => {
    const { status, ledger } = await run(new MemoryWorkspace(), 'hello', { provider: 'openrouter', model: 'x/y', apiKey: 'sk-invalid' })
    expect(status).toBe('FAILED')
    expect(ledger.finished?.error).toBe('The OpenRouter API key was rejected. Update it in agent settings.')
    expect(ledger.finished?.code).toBe('KEY_REJECTED')
  })

  it('stops on a refusal without running tools', async () => {
    const { status, ledger } = await run(new MemoryWorkspace(), '@refuse', {})
    expect(status).toBe('REFUSED')
    expect(ledger.finished?.error).toBe('Scripted refusal.')
  })

  it('stops at the cost cap', async () => {
    const { status } = await run(new MemoryWorkspace(), [tool('list_files', {}), tool('list_files', {})].join('\n'), { costCapMicros: 20_000 })
    expect(status).toBe('BUDGET_EXCEEDED')
    expect(model.requests.length).toBe(1)
  })
})
