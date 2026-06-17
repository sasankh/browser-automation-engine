import type { FastifyInstance } from 'fastify';
import type { Db } from '../../persistence/db';
import type { EnvConfig } from '../../shared/env';

/** Liveness + DB reachability + live saturation (zeros until Phase 3 wires the semaphore). */
export function registerHealthRoutes(app: FastifyInstance, db: Db, env: EnvConfig): void {
  app.get('/v1/health', async (_req, reply) => {
    let dbUp = false;
    try {
      await db.query('SELECT 1');
      dbUp = true;
    } catch {
      dbUp = false;
    }
    return reply.code(dbUp ? 200 : 503).send({
      status: dbUp ? 'ok' : 'degraded',
      db: dbUp ? 'up' : 'down',
      runs_in_progress: 0,
      queue_depth: 0,
      max_concurrent_runs: env.maxConcurrentRuns,
    });
  });
}
