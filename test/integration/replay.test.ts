import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startFixture, type FixtureHandle } from '../fixtures/site/server';
import { loadEnvConfig } from '../../src/shared/env';
import { createDb } from '../../src/persistence/db';
import type { Db } from '../../src/persistence/db';
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
import { buildServer } from '../../src/transport/http-server';
import { newPlaybookId } from '../../src/shared/ids';
import type { PlaybookVersion } from '../../src/execution/playbook/playbook-schema';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';

let fixture: FixtureHandle;
let db: Db;
let app: FastifyInstance;
let playbooks: PlaybookRepository;
let pool: BrowserPool;
let tmp: string;

beforeAll(async () => {
  fixture = await startFixture();
  tmp = await mkdtemp(join(tmpdir(), 'rote-test-'));
  const env = loadEnvConfig({ DATABASE_URL: TEST_DB, STORAGE_LOCAL_PATH: tmp, PORT: '0' } as NodeJS.ProcessEnv);
  db = createDb(env);
  await runMigrations(db);
  const store = new LocalPlaybookStore(env.storageLocalPath);
  playbooks = new PlaybookRepository(db, store);
  const evidence = new LocalEvidenceStore(env.storageLocalPath);
  const runner = new PlaybookRunner(evidence);
  pool = new BrowserPool(env.browserRecycleRuns);
  const lifecycle = new Lifecycle(pool, env.maxConcurrentRuns, env.maxQueueDepth);
  const orchestrator = new RunOrchestrator({
    env,
    nodeEnv: process.env,
    runs: new RunStore(db),
    idempotency: new IdempotencyGuard(db),
    playbooks,
    runner,
    lifecycle,
    modelGateway: new ModelGateway(process.env),
    agentEngine: new AgentEngine({ evidence, selectorCache: new LocalSelectorCache(env.storageLocalPath), env: process.env }),
    fallback: new ModelGatewayFallback(new ModelGateway(process.env)),
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

interface TestEnvelope {
  meta: {
    run_id: string;
    status: string;
    mode: string | null;
    playbook_version: number | null;
    extraction_errors: Array<{ field: string; reason: string }> | null;
  };
  result: Record<string, unknown> | null;
}

async function submit(payload: object): Promise<{ status: number; runId: string; code?: string }> {
  const res = await app.inject({ method: 'POST', url: '/v1/runs', payload });
  const body = res.json() as { meta?: { run_id: string }; error?: { code: string } };
  return { status: res.statusCode, runId: body.meta?.run_id ?? '', code: body.error?.code };
}

async function poll(runId: string, timeoutMs = 45_000): Promise<TestEnvelope> {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${runId}` });
    const body = res.json() as TestEnvelope;
    if (['completed', 'completed_with_extraction_errors', 'failed'].includes(body.meta.status)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`run did not terminate: ${JSON.stringify(body.meta)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function extractionPlaybook(
  fixtureUrl: string,
  fields: Record<string, string>,
  outputFormat: Record<string, string>,
): PlaybookVersion {
  return {
    version: 1,
    engine_min_version: '1.0.0',
    playbook_type: 'extraction',
    output_format: outputFormat,
    required_data_keys: ['license_number', 'last_name'],
    steps: [
      { op: 'goto', url: `${fixtureUrl}/lookup` },
      { op: 'fill', selector: '#licNum', value: '{{data.license_number}}' },
      { op: 'fill', selector: '#lastNm', value: '{{data.last_name}}' },
      { op: 'click', selector: '#submit' },
      { op: 'wait_for', selector: '.results-table' },
      { op: 'extract', schema_ref: 'output_format', scope_selector: '.results-table', fields },
    ],
    assertions: [{ after_step: 4, expect: 'url_matches', pattern: 'results' }],
  };
}

async function seedExtraction(
  fields: Record<string, string>,
  outputFormat: Record<string, string>,
): Promise<string> {
  const id = newPlaybookId();
  await playbooks.create({
    id,
    url: `${fixture.url}/lookup`,
    instruction: 'look up a license',
    createdBy: 'manual',
    runId: null,
    body: extractionPlaybook(fixture.url, fields, outputFormat),
  });
  return id;
}

describe('Phase 2 — deterministic replay (offline fixture)', () => {
  it('extraction playbook returns a correct result, status completed', async () => {
    const id = await seedExtraction(
      { license_status: '.status', holder_name: '.holder', expiry_date: '.expiry' },
      { license_status: 'string', holder_name: 'string', expiry_date: 'string (ISO date)' },
    );
    const { status, runId } = await submit({
      playbook_id: id,
      data: { license_number: 'A123456', last_name: 'Nguyen' },
    });
    expect(status).toBe(202);
    const env = await poll(runId);
    expect(env.meta.status).toBe('completed');
    expect(env.meta.mode).toBe('playbook');
    expect(env.result).toEqual({
      license_status: 'active',
      holder_name: 'NGUYEN, A123456',
      expiry_date: '2027-12-31',
    });
  });

  it('action-only playbook returns result null, status completed', async () => {
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
        required_data_keys: ['name', 'email', 'message'],
        steps: [
          { op: 'goto', url: `${fixture.url}/action` },
          { op: 'fill', selector: '#name', value: '{{data.name}}' },
          { op: 'fill', selector: '#email', value: '{{data.email}}' },
          { op: 'fill', selector: '#message', value: '{{data.message}}' },
          { op: 'click', selector: '#send' },
          { op: 'wait_for', selector: '.confirmation' },
        ],
      },
    });
    const { runId } = await submit({
      playbook_id: id,
      data: { name: 'Ada', email: 'a@b.c', message: 'hello' },
    });
    const env = await poll(runId);
    expect(env.meta.status).toBe('completed');
    expect(env.result).toBeNull();
  });

  it('a missing field yields completed_with_extraction_errors (never guessed)', async () => {
    const id = await seedExtraction(
      { license_status: '.status', expiry_date: '.does-not-exist' },
      { license_status: 'string', expiry_date: 'string' },
    );
    const { runId } = await submit({ playbook_id: id, data: { license_number: 'A1', last_name: 'X' } });
    const env = await poll(runId);
    expect(env.meta.status).toBe('completed_with_extraction_errors');
    expect(env.result?.license_status).toBe('active');
    expect(env.result?.expiry_date).toBeNull();
    expect(env.meta.extraction_errors).toContainEqual({ field: 'expiry_date', reason: 'not_found_on_page' });
  });

  it('a missing required data key returns 422 before a browser launches', async () => {
    const id = await seedExtraction({ license_status: '.status' }, { license_status: 'string' });
    const { status, code } = await submit({ playbook_id: id, data: { license_number: 'A1' } });
    expect(status).toBe(422);
    expect(code).toBe('validation_error');
  });

  it('versioning: active pointer moves on rollback; pinned version overrides it', async () => {
    const id = await seedExtraction({ license_status: '.status' }, { license_status: 'string' });
    await playbooks.addVersion(
      id,
      extractionPlaybook(
        fixture.url,
        { license_status: '.status', holder_name: '.holder' },
        { license_status: 'string', holder_name: 'string' },
      ),
      'manual',
      null,
    );
    const data = { license_number: 'A1', last_name: 'Nguyen' };

    // active is now v2
    let env = await poll((await submit({ playbook_id: id, data })).runId);
    expect(env.meta.playbook_version).toBe(2);
    expect(env.result).toEqual({ license_status: 'active', holder_name: 'NGUYEN, A1' });

    // rollback to v1
    const act = await app.inject({ method: 'POST', url: `/v1/playbooks/${id}/activate`, payload: { version: 1 } });
    expect(act.statusCode).toBe(200);
    env = await poll((await submit({ playbook_id: id, data })).runId);
    expect(env.meta.playbook_version).toBe(1);
    expect(env.result).toEqual({ license_status: 'active' });

    // pinned v2 ignores the active pointer
    env = await poll((await submit({ playbook_id: id, playbook_version: 2, data })).runId);
    expect(env.meta.playbook_version).toBe(2);
    expect(env.result).toEqual({ license_status: 'active', holder_name: 'NGUYEN, A1' });
  });
});
