import 'dotenv/config';
import { loadEnvConfig } from './shared/env';
import { createDb } from './persistence/db';
import { runMigrations } from './persistence/migrate';
import { RunStore } from './persistence/runs/run-store.pg';
import { IdempotencyGuard } from './intake/idempotency';
import { LocalPlaybookStore } from './persistence/playbooks/store.local';
import { PlaybookRepository } from './persistence/playbooks/repository';
import { LocalEvidenceStore } from './persistence/evidence/evidence.local';
import { PlaybookRunner } from './execution/playbook/runner';
import { RunOrchestrator } from './orchestrator/run-orchestrator';
import { buildServer } from './transport/http-server';
import { shutdownBrowsers } from './browser/browser';
import { logger } from './shared/logger';

async function main(): Promise<void> {
  const env = loadEnvConfig();
  const db = createDb(env);

  // Migrations run automatically on start (LOCAL_DEV §2).
  await runMigrations(db);

  const playbookStore = new LocalPlaybookStore(env.storageLocalPath);
  const playbooks = new PlaybookRepository(db, playbookStore);
  const evidence = new LocalEvidenceStore(env.storageLocalPath);
  const runner = new PlaybookRunner(evidence);

  const orchestrator = new RunOrchestrator({
    env,
    nodeEnv: process.env,
    runs: new RunStore(db),
    idempotency: new IdempotencyGuard(db),
    playbooks,
    runner,
  });

  const app = buildServer({ env, db, orchestrator, playbooks, evidence });

  const shutdown = async (): Promise<void> => {
    await app.close().catch(() => undefined);
    await shutdownBrowsers().catch(() => undefined);
    await db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen({ host: '0.0.0.0', port: env.port });
  // SERVICE_MODE api/worker split arrives in Phase 6; Phase 2 always serves HTTP.
  logger.info({ port: env.port, mode: env.serviceMode }, 'rote started');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
