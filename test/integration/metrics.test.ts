import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { RunOrchestrator } from '../../src/orchestrator/run-orchestrator';
import { registerSaturationGauges } from '../../src/shared/metrics';
import { buildServer } from '../../src/transport/http-server';
import { newPlaybookId } from '../../src/shared/ids';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';

let fixture: FixtureHandle;
let db: Db;
let app: FastifyInstance;
let pool: BrowserPool;
let playbooks: PlaybookRepository;
let tmp: string;

beforeAll(async () => {
  fixture = await startFixture();
  tmp = await mkdtemp(join(tmpdir(), 'rote-metrics-'));
  const env = loadEnvConfig({ DATABASE_URL: TEST_DB, STORAGE_LOCAL_PATH: tmp, PORT: '0', ALLOW_PRIVATE_TARGETS: 'true' } as NodeJS.ProcessEnv);
  db = createDb(env);
  await runMigrations(db);
  playbooks = new PlaybookRepository(db, new LocalPlaybookStore(tmp));
  const evidence = new LocalEvidenceStore(tmp);
  pool = new BrowserPool(env.browserRecycleRuns);
  const lifecycle = new Lifecycle(pool, env.maxConcurrentRuns, env.maxQueueDepth);
  registerSaturationGauges(lifecycle);
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
    agentEngine: new AgentEngine({ evidence, selectorCache: new LocalSelectorCache(tmp), env: process.env }),
    fallback: new ModelGatewayFallback(modelGateway),
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

async function runOne(): Promise<void> {
  const id = newPlaybookId();
  await playbooks.create({
    id,
    url: `${fixture.url}/action`,
    instruction: 'action',
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
  const sub = await app.inject({ method: 'POST', url: '/v1/runs', payload: { playbook_id: id, data: {} } });
  const runId = (sub.json() as { meta: { run_id: string } }).meta.run_id;
  const start = Date.now();
  for (;;) {
    const s = (await app.inject({ method: 'GET', url: `/v1/runs/${runId}` })).json() as { meta: { status: string } };
    if (['completed', 'failed', 'completed_with_extraction_errors'].includes(s.meta.status)) break;
    if (Date.now() - start > 20_000) throw new Error('run did not finish');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Phase 7 — /metrics (Prometheus, ARCHITECTURE §11)', () => {
  it('exposes the full metric set, and a completed run increments runs_total', async () => {
    await runOne();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;

    for (const name of [
      'runs_total',
      'heal_total',
      'fallback_engaged_total',
      'agent_tokens_total',
      'run_duration_seconds',
      'webhook_delivery_total',
      'requests_rejected_total',
      'playbook_hit_ratio',
      'runs_in_progress',
      'queue_depth',
      'max_concurrent_runs',
    ]) {
      expect(body, name).toContain(name);
    }
    // The run we just executed shows up as a labeled sample.
    expect(body).toMatch(/runs_total\{mode="playbook",status="completed"\} [1-9]/);
    expect(body).toMatch(/run_duration_seconds_count\{mode="playbook"\}/);
    // Default process metrics are present too.
    expect(body).toContain('process_cpu_user_seconds_total');
  });
});
