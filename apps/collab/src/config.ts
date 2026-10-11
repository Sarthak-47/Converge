function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export const config = {
  port: Number(required('COLLAB_PORT', '1234')),
  databaseUrl: required('DATABASE_URL', 'postgres://converge:converge@localhost:5432/converge'),
  redisUrl: required('REDIS_URL', 'redis://localhost:6379'),
};
