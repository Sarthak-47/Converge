export type ComponentHealth = { status: string }

export type ApiHealth = {
  status: string
  components?: Record<string, ComponentHealth>
}

export type ServiceRow = { name: string; status: string }

// The API's health endpoint aggregates every dependency, including the collaboration
// service, so one request tells the shell whether the whole stack is up.
const SERVICES: Array<[label: string, component: string]> = [
  ['PostgreSQL', 'db'],
  ['Redis', 'redis'],
  ['Collaboration service', 'collab'],
]

export async function fetchHealth(signal?: AbortSignal): Promise<ServiceRow[]> {
  let body: ApiHealth
  try {
    const response = await fetch('/api/actuator/health', { signal })
    body = (await response.json()) as ApiHealth
  } catch (error) {
    if (signal?.aborted) throw error
    return [{ name: 'API', status: 'UNREACHABLE' }, ...SERVICES.map(([name]) => ({ name, status: 'UNKNOWN' }))]
  }
  return [
    { name: 'API', status: body.status },
    ...SERVICES.map(([name, key]) => ({ name, status: body.components?.[key]?.status ?? 'MISSING' })),
  ]
}
