import { Server } from '@hocuspocus/server';
import { Redis } from 'ioredis';
import pg from 'pg';
import { config } from './config.js';
import { checkHealth } from './health.js';

const db = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
redis.on('error', (error) => console.error(JSON.stringify({ level: 'ERROR', event: 'REDIS_ERROR', message: error.message })));

const server = new Server({
  port: config.port,
  quiet: true,
  stopOnSignals: false,

  async onRequest({ request, response }) {
    if (request.url === '/health') {
      const report = await checkHealth(db, redis);
      response.writeHead(report.status === 'UP' ? 200 : 503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(report));
      // Hocuspocus treats a thrown null as "request handled".
      throw null;
    }
  },

  // Phase 0: no document access until ticket auth lands in Phase 3 (design §12.4).
  async onAuthenticate() {
    throw new Error('Document connections are not enabled yet');
  },
});

await redis.connect().catch(() => undefined);
await server.listen();
console.log(JSON.stringify({ level: 'INFO', event: 'COLLAB_STARTED', port: config.port }));

const shutdown = async () => {
  await server.destroy();
  await Promise.allSettled([db.end(), redis.quit()]);
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
