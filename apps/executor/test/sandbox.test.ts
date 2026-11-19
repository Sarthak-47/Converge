import Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JOB_LABEL, Sandbox, type Stream } from '../src/sandbox.js'

/**
 * Gate C (design §19.2): a job cannot reach the network, the host's Docker socket, the executor's secrets or
 * other workspaces; it runs unprivileged under hard limits and its container is always removed. Runs the
 * sandbox directly with arbitrary commands, which is exactly what the allowlist exists to prevent, to show the
 * container would hold even if a command slipped through. Skipped where Docker is not reachable.
 */
const docker = new Docker()
const available = await docker.ping().then(() => true, () => false)
const IMAGE = process.env.SANDBOX_IMAGE ?? 'node:24-alpine'

const sandbox = new Sandbox(docker, { image: IMAGE, timeoutMs: 20_000, memoryMb: 256, cpus: 1, maxOutputBytes: 64 * 1024 })

async function run(argv: string[], files = new Map<string, string>(), overrides?: Partial<ConstructorParameters<typeof Sandbox>[1]>) {
  const box = overrides ? new Sandbox(docker, { image: IMAGE, timeoutMs: 20_000, memoryMb: 256, cpus: 1, maxOutputBytes: 64 * 1024, ...overrides }) : sandbox
  const output: Array<[Stream, string]> = []
  const result = await box.run({ jobId: `test-${Math.random().toString(36).slice(2)}`, files, argv, onOutput: (s, c) => output.push([s, c]) })
  const text = (stream: Stream) => output.filter(([s]) => s === stream).map(([, c]) => c).join('')
  return { ...result, stdout: text('stdout'), stderr: text('stderr'), system: text('system') }
}

describe.skipIf(!available)('the job sandbox (Gate C)', () => {
  beforeAll(async () => {
    process.env.CONVERGE_TEST_SECRET = 'must-not-leak'
    await sandbox.prepare()
  }, 300_000)

  afterAll(async () => {
    const left = await docker.listContainers({ all: true, filters: { label: [JOB_LABEL] } })
    expect(left.filter((c) => c.Labels[JOB_LABEL]?.startsWith('test-'))).toEqual([])
  })

  it('runs the workspace files as an unprivileged user and streams output', async () => {
    const files = new Map([
      ['package.json', '{"name":"demo","scripts":{"test":"node --test"}}'],
      ['tests/math.test.js', "import test from 'node:test'\nimport assert from 'node:assert'\ntest('adds', () => assert.equal(1 + 1, 2))\n"],
    ])
    const tests = await run(['node', '--test'], files)
    expect(tests.exitCode).toBe(0)
    expect(tests.stdout).toContain('pass 1')

    const who = await run(['id', '-u'])
    expect(who.stdout.trim()).toBe('1000')
  }, 60_000)

  it('has no network, no Docker socket and none of the executor environment', async () => {
    const network = await run(['node', '-e', "fetch('http://1.1.1.1').then(() => console.log('reached'), () => console.log('blocked'))"])
    expect(network.stdout.trim()).toBe('blocked')
    const socket = await run(['ls', '/var/run/docker.sock'])
    expect(socket.exitCode).not.toBe(0)
    const env = await run(['env'])
    expect(env.stdout).not.toContain('must-not-leak')
    expect(env.stdout).not.toMatch(/DATABASE_URL|INTERNAL_TOKEN/)
  }, 60_000)

  it('cannot escalate privileges and runs under memory and process limits', async () => {
    const caps = await run(['sh', '-c', 'grep CapEff /proc/self/status'])
    expect(caps.stdout).toMatch(/CapEff:\s+0+\s*$/m)
    const memory = await run(['sh', '-c', 'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes'])
    expect(Number(memory.stdout.trim())).toBe(256 * 1024 * 1024)
    const pids = await run(['sh', '-c', 'cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max'])
    expect(pids.stdout.trim()).toBe('256')
  }, 60_000)

  it('kills a job that runs past its timeout', async () => {
    const started = Date.now()
    const result = await run(['node', '-e', 'setInterval(() => {}, 1000)'], new Map(), { timeoutMs: 2000 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.system).toContain('ran longer than 2 s')
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 60_000)

  it('caps the output it keeps', async () => {
    const result = await run(['node', '-e', "process.stdout.write('x'.repeat(200000))"], new Map(), { maxOutputBytes: 1000 })
    expect(result.outputTruncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(1000)
  }, 60_000)
})
