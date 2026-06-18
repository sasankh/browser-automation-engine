import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startFixture, type FixtureHandle } from '../fixtures/site/server';
import { loadEnvConfig } from '../../src/shared/env';
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
import { HttpWebhookDispatcher } from '../../src/shared/webhook';
import { RunOrchestrator } from '../../src/orchestrator/run-orchestrator';
import { buildServer } from '../../src/transport/http-server';
import { newPlaybookId } from '../../src/shared/ids';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';

// A controllable webhook receiver: records bodies and replies with a configurable status code.
interface Receiver {
  url: string;
  received: unknown[];
  setStatus: (code: number) => void;
  close: () => Promise<void>;
}
function startReceiver(): Promise<Receiver> {
  let status = 200;
  const received: unknown[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body || '{}'));
      res.writeHead(status).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        setStatus: (c) => (status = c),
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

let fixture: FixtureHandle;
let db: Db;
let app: FastifyInstance;
let pool: BrowserPool;
let playbooks: PlaybookRepository;
let tmp: string;

beforeAll(async () => {
  fixture = await startFixture();
  tmp = await mkdtemp(join(tmpdir(), 'rote-webhook-'));
  // Low retry count keeps the failed-delivery test fast.
  const env = loadEnvConfig({ DATABASE_URL: TEST_DB, STORAGE_LOCAL_PATH: tmp, PORT: '0', WEBHOOK_MAX_RETRIES: '2', ALLOW_PRIVATE_TARGETS: 'true' } as NodeJS.ProcessEnv);
  db = createDb(env);
  await runMigrations(db);
  playbooks = new PlaybookRepository(db, new LocalPlaybookStore(env.storageLocalPath));
  const evidence = new LocalEvidenceStore(env.storageLocalPath);
  pool = new BrowserPool(env.browserRecycleRuns);
  const lifecycle = new Lifecycle(pool, env.maxConcurrentRuns, env.maxQueueDepth);
  const modelGateway = new ModelGateway(process.env);
  const orchestrator = new RunOrchestrator({
    env,
    nodeEnv: process.env,
    runs: new RunStore(db),
    idempotency: new IdempotencyGuard(db),
    playbooks,
    runner: new PlaybookRunner(evidence),
    lifecycle,
    modelGateway,
    agentEngine: new AgentEngine({ evidence, selectorCache: new LocalSelectorCache(env.storageLocalPath), env: process.env }),
    fallback: new ModelGatewayFallback(modelGateway),
    webhook: new HttpWebhookDispatcher(env.webhookMaxRetries),
  });
  app = buildServer({ db, orchestrator, playbooks, evidence, lifecycle });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.shutdown();
  await db?.end();
  await fixture?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

interface Envelope {
  meta: { status: string; webhook_status?: string | null };
  result: Record<string, unknown> | null;
}

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

async function submit(payload: object): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/runs', payload });
  expect(res.statusCode).toBe(202);
  return (res.json() as { meta: { run_id: string } }).meta.run_id;
}

async function pollRun(runId: string, until: (e: Envelope) => boolean, timeoutMs = 20_000): Promise<Envelope> {
  const start = Date.now();
  for (;;) {
    const env = (await app.inject({ method: 'GET', url: `/v1/runs/${runId}` })).json() as Envelope;
    if (until(env)) return env;
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met: ${JSON.stringify(env.meta)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Phase 6 — webhook delivery (unsigned, retried; DECISIONS #30)', () => {
  it('delivers the terminal envelope to callback_url and records webhook_status=delivered', async () => {
    const receiver = await startReceiver();
    try {
      const id = await seedAction();
      const runId = await submit({ playbook_id: id, data: {}, callback_url: receiver.url });
      const env = await pollRun(runId, (e) => e.meta.webhook_status === 'delivered');
      expect(env.meta.status).toBe('completed');
      expect(receiver.received).toHaveLength(1);
      expect((receiver.received[0] as Envelope).meta.status).toBe('completed');
    } finally {
      await receiver.close();
    }
  });

  it('retries on a persistent 500 and records webhook_status=failed', async () => {
    const receiver = await startReceiver();
    receiver.setStatus(500);
    try {
      const id = await seedAction();
      const runId = await submit({ playbook_id: id, data: {}, callback_url: receiver.url });
      const env = await pollRun(runId, (e) => e.meta.webhook_status === 'failed', 25_000);
      expect(env.meta.status).toBe('completed'); // the run itself still completed
      expect(receiver.received.length).toBe(3); // 1 + WEBHOOK_MAX_RETRIES(2) attempts
    } finally {
      await receiver.close();
    }
  });
});
