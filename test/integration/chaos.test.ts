import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
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
import type { EvidenceStore } from '../../src/persistence/evidence/evidence';
import { PlaybookRunner } from '../../src/execution/playbook/runner';
import { BrowserPool } from '../../src/browser/pool';
import { Lifecycle } from '../../src/orchestrator/lifecycle';
import { ModelGateway } from '../../src/model/model-gateway';
import { AgentEngine } from '../../src/execution/agent/agent-engine';
import { ModelGatewayFallback } from '../../src/execution/playbook/llm-fallback';
import { LocalSelectorCache } from '../../src/persistence/cache/selector-cache';
import { RunOrchestrator } from '../../src/orchestrator/run-orchestrator';
import { registerHealthRoutes } from '../../src/transport/routes/health';
import { buildServer } from '../../src/transport/http-server';
import { newPlaybookId } from '../../src/shared/ids';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';

let fixture: FixtureHandle;
let db: Db;
let app: FastifyInstance;
let pool: BrowserPool;
let playbooks: PlaybookRepository;
let tmp: string;

/** An evidence store that fails every save — simulates S3/disk unavailable mid-run. */
const brokenEvidence: EvidenceStore = {
  save: () => Promise.reject(new Error('storage unavailable')),
  readFile: () => Promise.resolve(null),
  urlFor: () => Promise.resolve(null),
};

beforeAll(async () => {
  fixture = await startFixture();
  tmp = await mkdtemp(join(tmpdir(), 'rote-chaos-'));
  const env = loadEnvConfig({ DATABASE_URL: TEST_DB, STORAGE_LOCAL_PATH: tmp, PORT: '0', ALLOW_PRIVATE_TARGETS: 'true' } as NodeJS.ProcessEnv);
  db = createDb(env);
  await runMigrations(db);
  playbooks = new PlaybookRepository(db, new LocalPlaybookStore(tmp));
  pool = new BrowserPool(env.browserRecycleRuns);
  const lifecycle = new Lifecycle(pool, env.maxConcurrentRuns, env.maxQueueDepth);
  const modelGateway = new ModelGateway(process.env);
  const orchestrator = new RunOrchestrator({
    env,
    nodeEnv: process.env,
    runs: new RunStore(db),
    idempotency: new IdempotencyGuard(db),
    playbooks,
    runner: new PlaybookRunner(brokenEvidence), // evidence subsystem is "down"
    lifecycle,
    modelGateway,
    agentEngine: new AgentEngine({ evidence: new LocalEvidenceStore(tmp), selectorCache: new LocalSelectorCache(tmp), env: process.env }),
    fallback: new ModelGatewayFallback(modelGateway),
  });
  app = buildServer({ db, orchestrator, playbooks, evidence: brokenEvidence, lifecycle });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.shutdown();
  await db?.end();
  await fixture?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('Phase 7 — chaos & graceful degradation', () => {
  it('evidence storage down mid-run → the run still completes (evidence is best-effort)', async () => {
    const id = newPlaybookId();
    await playbooks.create({
      id,
      url: `${fixture.url}/lookup`,
      instruction: 'lookup',
      createdBy: 'manual',
      runId: null,
      body: {
        version: 1,
        engine_min_version: '1.0.0',
        playbook_type: 'extraction',
        output_format: { license_status: 'string' },
        required_data_keys: ['license_number', 'last_name'],
        steps: [
          { op: 'goto', url: `${fixture.url}/lookup` },
          { op: 'fill', selector: '#licNum', value: '{{data.license_number}}' },
          { op: 'fill', selector: '#lastNm', value: '{{data.last_name}}' },
          { op: 'click', selector: '#submit' },
          { op: 'wait_for', selector: '.results-table' },
          { op: 'extract', schema_ref: 'output_format', scope_selector: '.results-table', fields: { license_status: '.status' } },
        ],
      },
    });
    const sub = await app.inject({ method: 'POST', url: '/v1/runs', payload: { playbook_id: id, data: { license_number: 'A1', last_name: 'Nguyen' } } });
    const runId = (sub.json() as { meta: { run_id: string } }).meta.run_id;
    const start = Date.now();
    let env: { meta: { status: string; evidence: unknown }; result: Record<string, unknown> | null } | undefined;
    for (;;) {
      env = (await app.inject({ method: 'GET', url: `/v1/runs/${runId}` })).json();
      if (env && ['completed', 'failed', 'completed_with_extraction_errors'].includes(env.meta.status)) break;
      if (Date.now() - start > 20_000) throw new Error('run did not finish');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(env?.meta.status).toBe('completed'); // data is correct; evidence failure is non-fatal
    expect(env?.result).toMatchObject({ license_status: 'active' });
    expect(env?.meta.evidence).toBeNull(); // evidence wasn't captured
  });

  it('Postgres unreachable → /v1/health degrades to 503 (no red-screen stack)', async () => {
    const deadDb = createDb(loadEnvConfig({ DATABASE_URL: TEST_DB } as NodeJS.ProcessEnv));
    await deadDb.end(); // simulate the DB going away
    const bare = Fastify();
    registerHealthRoutes(bare, deadDb, new Lifecycle(pool, 3, 20));
    await bare.ready();
    try {
      const res = await bare.inject({ method: 'GET', url: '/v1/health' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { status: string; db: string };
      expect(body.status).toBe('degraded');
      expect(body.db).toBe('down');
    } finally {
      await bare.close();
    }
  });
});
