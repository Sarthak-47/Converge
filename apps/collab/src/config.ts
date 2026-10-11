function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

function list(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export const config = {
  port: Number(required('COLLAB_PORT', '1234')),
  databaseUrl: required('DATABASE_URL', 'postgres://converge:converge@localhost:5432/converge'),
  redisUrl: required('REDIS_URL', 'redis://localhost:6379'),
  /** Base URL of the API, used to redeem tickets (design §5.3). */
  apiUrl: required('API_URL', 'http://localhost:8080'),
  /** Shared secret for /internal calls in both directions; empty refuses all of them. */
  internalToken: process.env.INTERNAL_TOKEN ?? '',
  /** Origins allowed to open document sockets; empty means "do not check" (local development). */
  allowedOrigins: list('COLLAB_ALLOWED_ORIGINS'),
}
