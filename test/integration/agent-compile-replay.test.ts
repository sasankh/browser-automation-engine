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
import { LocalSelectorCache } from '../../src/persistence/cache/selector-cache';
import { RunOrchestrator } from '../../src/orchestrator/run-orchestrator';
import { buildServer } from '../../src/transport/http-server';
import { newPlaybookId } from '../../src/shared/ids';
import { compilePlaybook } from '../../src/execution/agent/compiler';
import type { RecordedAction } from '../../src/execution/agent/recorded-action';

// This proves the DETERMINISTIC half of the two-speed thesis end to end: a compiled playbook replays
// with DIFFERENT data and zero LLM. The live learn→compile half is exercised opt-in (agent-live.test).
const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';

let fixture: FixtureHandle;
let db: Db;
let app: FastifyInstance;
let playbooks: PlaybookRepository;
let pool: BrowserPool;
let tmp: string;

beforeAll(async () => {
  fixture = await startFixture();
  tmp = await mkdtemp(join(tmpdir(), 'rote-agentpb-'));
  const env = loadEnvConfig({ DATABASE_URL: TEST_DB, STORAGE_LOCAL_PATH: tmp, PORT: '0' } as NodeJS.ProcessEnv);
  db = createDb(env);
  await runMigrations(db);
  playbooks = new PlaybookRepository(db, new LocalPlaybookStore(env.storageLocalPath));
  const evidence = new LocalEvidenceStore(env.storageLocalPath);
  pool = new BrowserPool(env.browserRecycleRuns);
  const lifecycle = new Lifecycle(pool, env.maxConcurrentRuns, env.maxQueueDepth);
  const orchestrator = new RunOrchestrator({
    env,
    nodeEnv: process.env,
    runs: new RunStore(db),
    idempotency: new IdempotencyGuard(db),
    playbooks,
    runner: new PlaybookRunner(evidence),
    lifecycle,
    modelGateway: new ModelGateway(process.env),
    agentEngine: new AgentEngine({ evidence, selectorCache: new LocalSelectorCache(env.storageLocalPath), env: process.env }),
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
  meta: { status: string; mode: string | null; playbook_version: number | null };
  result: Record<string, unknown> | null;
}

async function submit(payload: object): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/runs', payload });
  expect(res.statusCode).toBe(202);
  return (res.json() as { meta: { run_id: string } }).meta.run_id;
}

async function poll(runId: string, timeoutMs = 30_000): Promise<Envelope> {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${runId}` });
    const body = res.json() as Envelope;
    if (['completed', 'completed_with_extraction_errors', 'failed'].includes(body.meta.status)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`run did not terminate: ${JSON.stringify(body.meta)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A recorded agent stream for the fixture lookup flow, learned with `learn` as the typed values. */
function lookupRecording(fixtureUrl: string, learn: { license: string; last: string }): RecordedAction[] {
  return [
    { op: 'goto', url: `${fixtureUrl}/lookup` },
    { op: 'fill', selector: '#licNum', value: learn.license, dataProvenance: 'license_number' },
    { op: 'fill', selector: '#lastNm', value: learn.last, dataProvenance: 'last_name' },
    { op: 'click', selector: '#submit', fallbackSelectors: ['button[type=submit]'] },
    { op: 'wait_for', selector: '.results-table' },
  ];
}

async function seedCompiled(body: ReturnType<typeof compilePlaybook>): Promise<string> {
  const id = newPlaybookId();
  await playbooks.create({
    id,
    url: body.steps[0]?.url ?? fixture.url,
    instruction: 'compiled from a recorded agent run',
    createdBy: 'agent_initial', // provenance: this version came from an agent learn run
    runId: null,
    body,
  });
  return id;
}

describe('Phase 4 — compile → replay round-trip (deterministic, no LLM)', () => {
  it('a compiled playbook replays with DIFFERENT data and produces the right result', async () => {
    // Learn with one set of inputs...
    const body = compilePlaybook({
      recorded: lookupRecording(fixture.url, { license: 'LEARN-1', last: 'Learnerson' }),
      outputFormat: { license_status: 'string', holder_name: 'string', expiry_date: 'string (ISO date)' },
      extractionFields: { license_status: '.status', holder_name: '.holder', expiry_date: '.expiry' },
      scopeSelector: '.results-table',
    });
    expect(body.required_data_keys).toEqual(['license_number', 'last_name']);
    const id = await seedCompiled(body);

    // ...replay with entirely different inputs (the thesis: parameterization generalizes).
    const env = await poll(await submit({ playbook_id: id, data: { license_number: 'B987654', last_name: 'Nguyen' } }));
    expect(env.meta.status).toBe('completed');
    expect(env.meta.mode).toBe('playbook');
    expect(env.result).toEqual({
      license_status: 'active',
      holder_name: 'NGUYEN, B987654',
      expiry_date: '2027-12-31',
    });
  });

  it('a data value that also appears as static page text is not mis-templated (provenance, not string-match)', async () => {
    // Learn with last_name = "active" — which ALSO renders as the .status text on the results page.
    const body = compilePlaybook({
      recorded: lookupRecording(fixture.url, { license: 'L1', last: 'active' }),
      outputFormat: { license_status: 'string', holder_name: 'string' },
      extractionFields: { license_status: '.status', holder_name: '.holder' },
      scopeSelector: '.results-table',
    });
    // The extract step's selectors stay literal — never templated to {{data.*}} by a page-text match.
    const extract = body.steps.at(-1);
    expect(extract?.fields).toEqual({ license_status: '.status', holder_name: '.holder' });
    const id = await seedCompiled(body);

    // Replay with a different last_name — the status extraction is unaffected, holder reflects new data.
    const env = await poll(await submit({ playbook_id: id, data: { license_number: 'X1', last_name: 'Smith' } }));
    expect(env.result).toEqual({ license_status: 'active', holder_name: 'SMITH, X1' });
  });

  it('an action-only recording compiles a type:action playbook; replay returns result null', async () => {
    const body = compilePlaybook({
      recorded: [
        { op: 'goto', url: `${fixture.url}/action` },
        { op: 'fill', selector: '#name', value: 'Ada', dataProvenance: 'name' },
        { op: 'fill', selector: '#email', value: 'a@b.c', dataProvenance: 'email' },
        { op: 'fill', selector: '#message', value: 'hi', dataProvenance: 'message' },
        { op: 'click', selector: '#send' },
        { op: 'wait_for', selector: '.confirmation' },
      ],
      outputFormat: null,
    });
    expect(body.playbook_type).toBe('action');
    const id = await seedCompiled(body);
    const env = await poll(await submit({ playbook_id: id, data: { name: 'Grace', email: 'g@h.i', message: 'yo' } }));
    expect(env.meta.status).toBe('completed');
    expect(env.result).toBeNull();
  });
});

describe('Phase 4 — agent intake validation (require-explicit model, no LLM)', () => {
  it('an instruction+url run with no model resolved is rejected 422 before any browser launches', async () => {
    // No payload.config.model and no CONFIG_MODEL env ⇒ require-explicit fires (DECISIONS #11).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      payload: { instruction: 'look up a license', url: `${fixture.url}/lookup`, data: { license_number: 'A1' } },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('validation_error');
  });

  it('a model whose provider key is absent is rejected 422 (env-only secret)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/runs',
      payload: {
        instruction: 'look up a license',
        url: `${fixture.url}/lookup`,
        data: { license_number: 'A1' },
        config: { model: 'openai/gpt-4.1' }, // OPENAI_API_KEY not set in the test env
      },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { code: string } }).error.code).toBe('validation_error');
  });
});
