import 'dotenv/config';
import { loadEnvConfig } from './shared/env';
import { createDb } from './persistence/db';
import { runMigrations } from './persistence/migrate';
import { RunStore } from './persistence/runs/run-store.pg';
import { IdempotencyGuard } from './intake/idempotency';
import { RunOrchestrator } from './orchestrator/run-orchestrator';
import { buildServer } from './transport/http-server';
import { logger } from './shared/logger';

async function main(): Promise<void> {
  const env = loadEnvConfig();
  const db = createDb(env);

  // Migrations run automatically on start (LOCAL_DEV §2).
  await runMigrations(db);

  const orchestrator = new RunOrchestrator({
    env,
    nodeEnv: process.env,
    runs: new RunStore(db),
    idempotency: new IdempotencyGuard(db),
  });

  const app = buildServer({ env, db, orchestrator });
  await app.listen({ host: '0.0.0.0', port: env.port });
  // SERVICE_MODE api/worker split arrives in Phase 6; Phase 1 always serves HTTP.
  logger.info({ port: env.port, mode: env.serviceMode }, 'rote started');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
