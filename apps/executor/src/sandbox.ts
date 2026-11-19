import { PassThrough } from 'node:stream'
import Docker from 'dockerode'
import { pack } from 'tar-stream'

export type Stream = 'stdout' | 'stderr' | 'system'

export type SandboxLimits = {
  image: string
  runtime?: string
  timeoutMs: number
  memoryMb: number
  cpus: number
  maxOutputBytes: number
}

export type SandboxRun = {
  /** Label value, so leftovers from a crash can be found and removed. */
  jobId: string
  /** Workspace files, by path relative to /workspace. */
  files: Map<string, string>
  argv: string[]
  onOutput: (stream: Stream, chunk: string) => void
}

export type SandboxResult = { exitCode: number | null; timedOut: boolean; outputTruncated: boolean }

export const JOB_LABEL = 'converge.job'
/** The unprivileged user every job runs as (the node images' "node" user). */
const SANDBOX_USER = 1000

/** Builds the tar that becomes /workspace, owned by the sandbox user. */
function archive(files: Map<string, string>): Promise<Buffer> {
  const tar = pack()
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    tar.on('data', (chunk: unknown) => chunks.push(chunk as Buffer))
    tar.on('end', () => resolve(Buffer.concat(chunks)))
    tar.on('error', reject)
  })
  const owner = { uid: SANDBOX_USER, gid: SANDBOX_USER }
  const folders = new Set<string>(['workspace'])
  for (const path of files.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(`workspace/${parts.slice(0, i).join('/')}`)
  }
  for (const folder of [...folders].sort()) tar.entry({ name: folder, type: 'directory', mode: 0o755, ...owner })
  for (const [path, text] of files) tar.entry({ name: `workspace/${path}`, mode: 0o644, ...owner }, text)
  tar.finalize()
  return done
}

/**
 * One job in one throwaway container (design §11.2–11.3): no network, an unprivileged user, every capability
 * dropped, no privilege escalation, memory/CPU/process limits, a timeout, and nothing mounted from the host;
 * the workspace files are copied in. The container is always removed afterwards.
 */
export class Sandbox {
  constructor(private readonly docker: Docker, private readonly limits: SandboxLimits) {}

  /** Pulls the job image if it is not present yet. */
  async prepare(): Promise<void> {
    try {
      await this.docker.getImage(this.limits.image).inspect()
      return
    } catch {
      // not present; pull below
    }
    const stream = await this.docker.pull(this.limits.image)
    await new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(stream, (error: Error | null) => (error ? reject(error) : resolve())),
    )
  }

  /** Removes containers left behind by a previous executor process. */
  async removeLeftovers(): Promise<number> {
    const containers = await this.docker.listContainers({ all: true, filters: { label: [JOB_LABEL] } })
    await Promise.all(containers.map((c) => this.docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined)))
    return containers.length
  }

  async run(job: SandboxRun): Promise<SandboxResult> {
    const { limits } = this
    const memory = limits.memoryMb * 1024 * 1024
    const container = await this.docker.createContainer({
      Image: limits.image,
      Cmd: job.argv,
      WorkingDir: '/workspace',
      User: `${SANDBOX_USER}:${SANDBOX_USER}`,
      // Only harmless variables: nothing from the executor's own environment reaches a job.
      Env: ['HOME=/tmp', 'CI=true', 'NO_COLOR=1', 'npm_config_update_notifier=false', 'npm_config_cache=/tmp/.npm'],
      Labels: { [JOB_LABEL]: job.jobId },
      NetworkDisabled: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        NetworkMode: 'none',
        Memory: memory,
        MemorySwap: memory,
        NanoCpus: Math.round(limits.cpus * 1e9),
        PidsLimit: 256,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Tmpfs: { '/tmp': 'rw,nosuid,size=128m' },
        Runtime: limits.runtime,
      },
    })
    try {
      await container.putArchive(await archive(job.files), { path: '/' })
      const attached = await container.attach({ stream: true, stdout: true, stderr: true })
      let written = 0
      let truncated = false
      const forward = (stream: Stream) => {
        const sink = new PassThrough()
        sink.on('data', (data: Buffer) => {
          if (truncated) return
          const text = data.toString('utf8')
          if (written + text.length > limits.maxOutputBytes) {
            truncated = true
            job.onOutput('system', `\n… output truncated at ${limits.maxOutputBytes} bytes\n`)
            return
          }
          written += text.length
          job.onOutput(stream, text)
        })
        return sink
      }
      const stdout = forward('stdout')
      const stderr = forward('stderr')
      this.docker.modem.demuxStream(attached, stdout, stderr)
      const ended = new Promise<void>((resolve) => attached.on('end', () => resolve()))

      await container.start()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        container.kill().catch(() => undefined)
      }, limits.timeoutMs)
      const { StatusCode } = (await container.wait()) as { StatusCode: number }
      clearTimeout(timer)
      await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 2000))])
      if (timedOut) job.onOutput('system', `\nStopped: the job ran longer than ${Math.round(limits.timeoutMs / 1000)} s.\n`)
      return { exitCode: timedOut ? null : StatusCode, timedOut, outputTruncated: truncated }
    } finally {
      await container.remove({ force: true }).catch(() => undefined)
    }
  }
}
