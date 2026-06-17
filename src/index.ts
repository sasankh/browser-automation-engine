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
import { BrowserPool } from './browser/pool';
import { Lifecycle } from './orchestrator/lifecycle';
import { ModelGateway } from './model/model-gateway';
import { AgentEngine } from './execution/agent/agent-engine';
import { ModelGatewayFallback } from './execution/playbook/llm-fallback';
import { LocalSelectorCache } from './persistence/cache/selector-cache';
import { RunOrchestrator } from './orchestrator/run-orchestrator';
import { buildServer } from './transport/http-server';
import { checkMemoryBudget } from './shared/memory';
import { logger } from './shared/logger';

async function main(): Promise<void> {
  const env = loadEnvConfig();
  checkMemoryBudget(env.maxConcurrentRuns);

  const db = createDb(env);
  await runMigrations(db); // migrations run automatically on start (LOCAL_DEV §2)

  const pool = new BrowserPool(env.browserRecycleRuns);
  const lifecycle = new Lifecycle(pool, env.maxConcurrentRuns, env.maxQueueDepth);
  const playbookStore = new LocalPlaybookStore(env.storageLocalPath);
  const playbooks = new PlaybookRepository(db, playbookStore);
  const evidence = new LocalEvidenceStore(env.storageLocalPath);
  const runner = new PlaybookRunner(evidence);
  const modelGateway = new ModelGateway(process.env);
  const agentEngine = new AgentEngine({
    evidence,
    selectorCache: new LocalSelectorCache(env.storageLocalPath),
    env: process.env,
  });

  const orchestrator = new RunOrchestrator({
    env,
    nodeEnv: process.env,
    runs: new RunStore(db),
    idempotency: new IdempotencyGuard(db),
    playbooks,
    runner,
    lifecycle,
    modelGateway,
    agentEngine,
    fallback: new ModelGatewayFallback(modelGateway),
  });

  const app = buildServer({ db, orchestrator, playbooks, evidence, lifecycle });

  // Graceful drain on SIGTERM/SIGINT: stop intake, let in-flight runs finish within the grace
  // window, then tear down (ARCHITECTURE §8.4).
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ grace_seconds: env.shutdownGraceSeconds }, 'draining for shutdown');
    await lifecycle.drain(env.shutdownGraceSeconds * 1000);
    await app.close().catch(() => undefined);
    await pool.shutdown().catch(() => undefined);
    await db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen({ host: '0.0.0.0', port: env.port });
  // SERVICE_MODE api/worker split arrives in Phase 6; this phase always serves HTTP.
  logger.info(
    { port: env.port, mode: env.serviceMode, max_concurrent_runs: env.maxConcurrentRuns },
    'rote started',
  );
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
