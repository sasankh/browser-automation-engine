import type { FastifyInstance } from 'fastify';
import type { Db } from '../../persistence/db';
import type { Lifecycle } from '../../orchestrator/lifecycle';

/** Liveness + DB reachability + live saturation (runs_in_progress / queue_depth / max_concurrent_runs). */
export function registerHealthRoutes(app: FastifyInstance, db: Db, lifecycle: Lifecycle): void {
  app.get('/v1/health', async (_req, reply) => {
    let dbUp = false;
    try {
      await db.query('SELECT 1');
      dbUp = true;
    } catch {
      dbUp = false;
    }
    const sat = lifecycle.saturation();
    const status = !dbUp ? 'degraded' : lifecycle.isDraining ? 'draining' : 'ok';
    return reply.code(dbUp ? 200 : 503).send({
      status,
      db: dbUp ? 'up' : 'down',
      runs_in_progress: sat.runs_in_progress,
      queue_depth: sat.queue_depth,
      max_concurrent_runs: sat.max_concurrent_runs,
    });
  });
}
