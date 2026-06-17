import 'dotenv/config';
import { loadEnvConfig, type EnvConfig } from './shared/env';
import { createDb } from './persistence/db';
import { runMigrations } from './persistence/migrate';
import { RunStore } from './persistence/runs/run-store.pg';
import { IdempotencyGuard } from './intake/idempotency';
import { LocalPlaybookStore } from './persistence/playbooks/store.local';
import { S3PlaybookStore } from './persistence/playbooks/store.s3';
import type { PlaybookStore } from './persistence/playbooks/store';
import { PlaybookRepository } from './persistence/playbooks/repository';
import { LocalEvidenceStore } from './persistence/evidence/evidence.local';
import { S3EvidenceStore } from './persistence/evidence/evidence.s3';
import type { EvidenceStore } from './persistence/evidence/evidence';
import { LocalSelectorCache } from './persistence/cache/selector-cache';
import { S3SelectorCache } from './persistence/cache/selector-cache.s3';
import type { SelectorCache } from './persistence/cache/selector-cache';
import { makeS3Client, makeSqsClient } from './persistence/aws';
import { PlaybookRunner } from './execution/playbook/runner';
import { BrowserPool } from './browser/pool';
import { Lifecycle } from './orchestrator/lifecycle';
import { ModelGateway } from './model/model-gateway';
import { AgentEngine } from './execution/agent/agent-engine';
import { ModelGatewayFallback } from './execution/playbook/llm-fallback';
import { RunOrchestrator } from './orchestrator/run-orchestrator';
import { SqsJobEnqueuer, SqsResultsPublisher, NoopResultsPublisher } from './transport/sqs';
import type { JobEnqueuer, ResultsPublisher } from './transport/sqs';
import { SqsConsumer } from './transport/sqs-consumer';
import { HttpWebhookDispatcher } from './shared/webhook';
import { buildServer } from './transport/http-server';
import { checkMemoryBudget } from './shared/memory';
import { logger } from './shared/logger';

interface Storage {
  playbookStore: PlaybookStore;
  evidence: EvidenceStore;
  cache: SelectorCache;
}

/** Pick storage adapters by `STORAGE_BACKEND` — nothing above persistence branches on local vs s3. */
function makeStorage(env: EnvConfig): Storage {
  if (env.storageBackend === 's3') {
    if (!env.s3Bucket) throw new Error('STORAGE_BACKEND=s3 requires S3_BUCKET');
    const s3 = makeS3Client(env);
    return {
      playbookStore: new S3PlaybookStore(s3, env.s3Bucket),
      evidence: new S3EvidenceStore(s3, env.s3Bucket),
      cache: new S3SelectorCache(s3, env.s3Bucket),
    };
  }
  return {
    playbookStore: new LocalPlaybookStore(env.storageLocalPath),
    evidence: new LocalEvidenceStore(env.storageLocalPath),
    cache: new LocalSelectorCache(env.storageLocalPath),
  };
}

async function main(): Promise<void> {
  const env = loadEnvConfig();
  const isApi = env.serviceMode === 'api';
  if (isApi && !env.sqsEnabled) throw new Error('SERVICE_MODE=api requires SQS_ENABLED=true (+ SQS_QUEUE_URL)');
  if (env.sqsEnabled && !env.sqsQueueUrl) throw new Error('SQS_ENABLED requires SQS_QUEUE_URL');

  if (!isApi) checkMemoryBudget(env.maxConcurrentRuns); // the api task runs no browser

  const db = createDb(env);
  await runMigrations(db); // migrations run automatically on start (LOCAL_DEV §2)

  const pool = new BrowserPool(env.browserRecycleRuns);
  const lifecycle = new Lifecycle(pool, env.maxConcurrentRuns, env.maxQueueDepth);
  const { playbookStore, evidence, cache } = makeStorage(env);
  const playbooks = new PlaybookRepository(db, playbookStore);
  const runner = new PlaybookRunner(evidence);
  const modelGateway = new ModelGateway(process.env);
  const agentEngine = new AgentEngine({ evidence, selectorCache: cache, env: process.env });

  // SQS wiring: an enqueuer (the api task) + an optional results publisher.
  const sqs = env.sqsEnabled ? makeSqsClient(env) : undefined;
  const enqueuer: JobEnqueuer | undefined =
    sqs && env.sqsQueueUrl ? new SqsJobEnqueuer(sqs, env.sqsQueueUrl) : undefined;
  const results: ResultsPublisher =
    sqs && env.sqsResultsQueueUrl ? new SqsResultsPublisher(sqs, env.sqsResultsQueueUrl) : new NoopResultsPublisher();

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
    mode: isApi ? 'enqueue' : 'inline',
    enqueuer,
    webhook: new HttpWebhookDispatcher(env.webhookMaxRetries),
    results,
  });

  // The consumer runs on `worker` (and `all` when SQS is enabled) — never on `api`.
  const consumer =
    sqs && env.sqsQueueUrl && !isApi
      ? new SqsConsumer({
          sqs,
          queueUrl: env.sqsQueueUrl,
          orchestrator,
          maxConcurrentRuns: env.maxConcurrentRuns,
          visibilityTimeoutSeconds: env.sqsVisibilityTimeoutSeconds,
        })
      : undefined;

  const app = buildServer({ db, orchestrator, playbooks, evidence, lifecycle });

  // Graceful drain on SIGTERM/SIGINT: stop intake (consumer + queue), let in-flight runs finish within
  // the grace window, then tear down (ARCHITECTURE §8.4). Fargate deploys don't sever live sessions.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ grace_seconds: env.shutdownGraceSeconds }, 'draining for shutdown');
    await consumer?.stop(env.shutdownGraceSeconds * 1000);
    await lifecycle.drain(env.shutdownGraceSeconds * 1000);
    await app.close().catch(() => undefined);
    await pool.shutdown().catch(() => undefined);
    await db.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen({ host: '0.0.0.0', port: env.port });
  consumer?.start();
  logger.info(
    {
      port: env.port,
      mode: env.serviceMode,
      storage: env.storageBackend,
      sqs: env.sqsEnabled,
      consumer: Boolean(consumer),
      max_concurrent_runs: env.maxConcurrentRuns,
    },
    'rote started',
  );
}

main().catch((err: unknown) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
