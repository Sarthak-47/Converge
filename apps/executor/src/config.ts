function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') throw new Error(`Missing required environment variable ${name}`)
  return value
}

function number(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  return value
}

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://converge:converge@localhost:5432/converge'),
  apiUrl: required('API_URL', 'http://localhost:8080'),
  internalToken: process.env.INTERNAL_TOKEN ?? '',
  /** Image every job runs in. */
  image: required('SANDBOX_IMAGE', 'node:24-alpine'),
  /** Optional container runtime, e.g. "runsc" for gVisor once execution is reachable by others (design §11.3). */
  runtime: process.env.SANDBOX_RUNTIME || undefined,
  timeoutMs: number('JOB_TIMEOUT_MS', 120_000),
  memoryMb: number('JOB_MEMORY_MB', 512),
  cpus: number('JOB_CPUS', 1),
  pollMs: number('JOB_POLL_MS', 1000),
  /** Total size of the files copied into one job. */
  maxFilesBytes: number('JOB_MAX_FILES_BYTES', 20 * 1024 * 1024),
  /** Where the worker keeps one Git checkout per workspace (a volume in Compose). */
  gitRoot: required('GIT_ROOT', '/var/lib/converge-git'),
  /** GitHub's REST API; tests point it at the fake GitHub. */
  githubApi: required('GITHUB_API_URL', 'https://api.github.com'),
  /** The API's secrets key, to open the stored Git credential of the repository being pushed to. */
  secretsKey: process.env.SECRETS_KEY ?? '',
  /** Output kept per job; the rest is dropped with a note. */
  maxOutputBytes: number('JOB_MAX_OUTPUT_BYTES', 1024 * 1024),
}
