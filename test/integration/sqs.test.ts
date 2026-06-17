import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { startFixture, type FixtureHandle } from '../fixtures/site/server';
import { loadEnvConfig } from '../../src/shared/env';
import { makeSqsClient } from '../../src/persistence/aws';
import { createDb, type Db } from '../../src/persistence/db';
import { runMigrations } from '../../src/persistence/migrate';
import { RunStore } from '../../src/persistence/runs/run-store.pg';
import { IdempotencyGuard } from '../../src/intake/idempotency';
import { LocalPlaybookStore } from '../../src/persistence/playbooks/store.local';
import { PlaybookRepository } from '../../src/persistence/playbooks/repository';
import { LocalEvidenceStore } from '../../src/persistence/evidence/evidence.local';
import { PlaybookRunner } from '../../src/execution/playbook/runner';
import { BrowserPool } from '../../src/browser/pool';
import { Lifecycle } from '../../src/orchestrator/lifecycle';
import { ModelGateway } from '../../src/model/model-gateway';
import { AgentEngine } from '../../src/execution/agent/agent-engine';
import { ModelGatewayFallback } from '../../src/execution/playbook/llm-fallback';
import { LocalSelectorCache } from '../../src/persistence/cache/selector-cache';
import { RunOrchestrator } from '../../src/orchestrator/run-orchestrator';
import { SqsJobEnqueuer } from '../../src/transport/sqs';
import { SqsConsumer } from '../../src/transport/sqs-consumer';
import { newPlaybookId } from '../../src/shared/ids';
import type { Payload } from '../../src/intake/payload-schema';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';

const env = loadEnvConfig({
  DATABASE_URL: TEST_DB,
  AWS_ENDPOINT_URL: ENDPOINT,
  AWS_REGION: 'us-east-1',
} as NodeJS.ProcessEnv);

let fixture: FixtureHandle;
let db: Db;
let pool: BrowserPool;
let playbooks: PlaybookRepository;
let runs: RunStore;
let sqs: SQSClient;
let apiOrch: RunOrchestrator;
let workerOrch: RunOrchestrator;
let consumer: SqsConsumer;
let runsUrl: string;
let tmp: string;

/** A fresh runs queue + DLQ (maxReceiveCount=3) so each test is independent of other queues. */
async function createQueues(): Promise<{ runsUrl: string; dlqUrl: string }> {
  const suffix = `${Date.now()}_${Math.floor(performance.now())}`;
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `t-dlq-${suffix}` }));
  const dUrl = dlq.QueueUrl ?? '';
  const arn = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dUrl, AttributeNames: ['QueueArn'] }));
  const runsQ = await sqs.send(
    new CreateQueueCommand({
      QueueName: `t-runs-${suffix}`,
      Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn.Attributes?.QueueArn, maxReceiveCount: '3' }) },
    }),
  );
  return { runsUrl: runsQ.QueueUrl ?? '', dlqUrl: dUrl };
}

beforeAll(async () => {
  fixture = await startFixture();
  tmp = await mkdtemp(join(tmpdir(), 'rote-sqs-'));
  sqs = makeSqsClient(env);
  runsUrl = (await createQueues()).runsUrl;
  const storeEnv = loadEnvConfig({ DATABASE_URL: TEST_DB, STORAGE_LOCAL_PATH: tmp, PORT: '0' } as NodeJS.ProcessEnv);
  db = createDb(storeEnv);
  await runMigrations(db);
  playbooks = new PlaybookRepository(db, new LocalPlaybookStore(tmp));
  runs = new RunStore(db);
  const evidence = new LocalEvidenceStore(tmp);
  pool = new BrowserPool(storeEnv.browserRecycleRuns);
  const lifecycle = new Lifecycle(pool, storeEnv.maxConcurrentRuns, storeEnv.maxQueueDepth);
  const modelGateway = new ModelGateway(process.env);
  const shared = {
    env: storeEnv,
    nodeEnv: process.env,
    runs,
    idempotency: new IdempotencyGuard(db),
    playbooks,
    runner: new PlaybookRunner(evidence),
    lifecycle,
    modelGateway,
    agentEngine: new AgentEngine({ evidence, selectorCache: new LocalSelectorCache(tmp), env: process.env }),
    fallback: new ModelGatewayFallback(modelGateway),
  };
  // The `api` task: persist + enqueue (no execution). The `worker`: consume + execute inline.
  apiOrch = new RunOrchestrator({ ...shared, mode: 'enqueue', enqueuer: new SqsJobEnqueuer(sqs, runsUrl) });
  workerOrch = new RunOrchestrator({ ...shared, mode: 'inline' });
  consumer = new SqsConsumer({ sqs, queueUrl: runsUrl, orchestrator: workerOrch, maxConcurrentRuns: 2, visibilityTimeoutSeconds: 30 });
});

afterAll(async () => {
  await consumer?.stop(5_000);
  await pool?.shutdown();
  await db?.end();
  await fixture?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

async function seedAction(): Promise<string> {
  const id = newPlaybookId();
  await playbooks.create({
    id,
    url: `${fixture.url}/action`,
    instruction: 'submit the contact form',
    createdBy: 'manual',
    runId: null,
    body: {
      version: 1,
      engine_min_version: '1.0.0',
      playbook_type: 'action',
      output_format: null,
      required_data_keys: [],
      steps: [
        { op: 'goto', url: `${fixture.url}/action` },
        { op: 'fill', selector: '#name', value: 'Ada' },
        { op: 'click', selector: '#send' },
        { op: 'wait_for', selector: '.confirmation' },
      ],
    },
  });
  return id;
}

async function pollStatus(runId: string, until: (s: string) => boolean, timeoutMs = 25_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const env2 = await runs.getEnvelope(runId);
    if (env2 && until(env2.meta.status)) return env2.meta.status;
    if (Date.now() - start > timeoutMs) throw new Error(`status not reached: ${env2?.meta.status}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('Phase 6 — SQS api→worker (LocalStack)', () => {
  it('api enqueues, the worker consumes the same payload and runs it to completion', async () => {
    const id = await seedAction();
    const res = await apiOrch.submit({ playbook_id: id, data: {} } as Payload);
    expect(res.kind).toBe('accepted');
    const runId = res.kind === 'accepted' ? res.run_id : '';
    // Created queued by the api, not yet executed.
    expect((await runs.getEnvelope(runId))?.meta.status).toBe('queued');

    consumer.start();
    const status = await pollStatus(runId, (s) => s === 'completed');
    expect(status).toBe('completed');
  });

  it('redelivery is idempotent: re-running an already-settled run does not re-execute it', async () => {
    const id = await seedAction();
    const res = await apiOrch.submit({ playbook_id: id, data: {} } as Payload);
    const runId = res.kind === 'accepted' ? res.run_id : '';
    // Execute directly (simulating the worker), then "redeliver" by executing the same message again.
    await workerOrch.executeFromQueue(runId, { playbook_id: id, data: {} } as Payload);
    const first = await runs.getEnvelope(runId);
    expect(first?.meta.status).toBe('completed');
    const finishedAt = first?.meta.finished_at;

    await workerOrch.executeFromQueue(runId, { playbook_id: id, data: {} } as Payload); // redelivery
    const second = await runs.getEnvelope(runId);
    expect(second?.meta.status).toBe('completed');
    expect(second?.meta.finished_at).toBe(finishedAt); // not re-run → unchanged
  });

  it('a poison message lands in the DLQ after maxReceiveCount, not an infinite loop', async () => {
    // Isolated queue pair so the e2e consumer (long visibility) can't intercept the poison message.
    const { runsUrl: pRuns, dlqUrl: pDlq } = await createQueues();
    const poisonConsumer = new SqsConsumer({ sqs, queueUrl: pRuns, orchestrator: workerOrch, maxConcurrentRuns: 1, visibilityTimeoutSeconds: 1 });
    await sqs.send(new SendMessageCommand({ QueueUrl: pRuns, MessageBody: '{not valid json at all' }));
    poisonConsumer.start();
    try {
      let found: string | undefined;
      const start = Date.now();
      while (Date.now() - start < 30_000) {
        const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: pDlq, WaitTimeSeconds: 2, MaxNumberOfMessages: 1 }));
        if (res.Messages && res.Messages.length > 0) {
          found = res.Messages[0]?.Body;
          break;
        }
      }
      expect(found).toContain('not valid json');
    } finally {
      await poisonConsumer.stop(2_000);
    }
  }, 40_000);
});
