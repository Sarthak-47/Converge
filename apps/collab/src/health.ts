import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

type ComponentStatus = { status: 'UP' | 'DOWN'; error?: string };

export type HealthReport = {
  status: 'UP' | 'DOWN';
  components: Record<string, ComponentStatus>;
};

async function probe(check: () => Promise<unknown>, timeoutMs = 2000): Promise<ComponentStatus> {
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)),
    ]);
    return { status: 'UP' };
  } catch (error) {
    return { status: 'DOWN', error: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkHealth(db: Pool, redis: Redis): Promise<HealthReport> {
  const [database, cache] = await Promise.all([
    probe(() => db.query('select 1')),
    probe(() => redis.ping()),
  ]);
  const components = { db: database, redis: cache };
  const status = Object.values(components).every((c) => c.status === 'UP') ? 'UP' : 'DOWN';
  return { status, components };
}
