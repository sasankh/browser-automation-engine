import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
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
import { buildServer } from '../../src/transport/http-server';
import { newPlaybookId } from '../../src/shared/ids';
import { parsePlaybookVersion } from '../../src/execution/playbook/playbook-schema';
import type { PlaybookVersion } from '../../src/execution/playbook/playbook-schema';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';

let fixture: FixtureHandle;
let db: Db;
let pool: BrowserPool;
let playbooks: PlaybookRepository;
let allowApp: FastifyInstance; // ALLOW_PRIVATE_TARGETS=true (fixture-facing)
let denyApp: FastifyInstance; // default deny (SSRF tests)
let tmp: string;

beforeAll(async () => {
  fixture = await startFixture();
  tmp = await mkdtemp(join(tmpdir(), 'rote-sec-'));
  const evidence = new LocalEvidenceStore(tmp);
  const base = (allowPrivate: boolean): RunOrchestrator => {
    const env = loadEnvConfig({
      DATABASE_URL: TEST_DB,
      STORAGE_LOCAL_PATH: tmp,
      PORT: '0',
      ...(allowPrivate ? { ALLOW_PRIVATE_TARGETS: 'true' } : {}),
    } as NodeJS.ProcessEnv);
    const modelGateway = new ModelGateway(process.env);
    return new RunOrchestrator({
      env,
      nodeEnv: process.env,
      runs: new RunStore(db),
      idempotency: new IdempotencyGuard(db),
      playbooks,
      runner: new PlaybookRunner(evidence),
      lifecycle: new Lifecycle(pool, env.maxConcurrentRuns, env.maxQueueDepth),
      modelGateway,
      agentEngine: new AgentEngine({ evidence, selectorCache: new LocalSelectorCache(tmp), env: process.env }),
      fallback: new ModelGatewayFallback(modelGateway),
    });
  };
  const env0 = loadEnvConfig({ DATABASE_URL: TEST_DB, STORAGE_LOCAL_PATH: tmp, PORT: '0' } as NodeJS.ProcessEnv);
  db = createDb(env0);
  await runMigrations(db);
  playbooks = new PlaybookRepository(db, new LocalPlaybookStore(tmp));
  pool = new BrowserPool(env0.browserRecycleRuns);
  const evid = new LocalEvidenceStore(tmp);
  allowApp = buildServer({ db, orchestrator: base(true), playbooks, evidence: evid, lifecycle: new Lifecycle(pool, 3, 20) });
  denyApp = buildServer({ db, orchestrator: base(false), playbooks, evidence: evid, lifecycle: new Lifecycle(pool, 3, 20) });
  await allowApp.ready();
  await denyApp.ready();
});

afterAll(async () => {
  await allowApp?.close();
  await denyApp?.close();
  await pool?.shutdown();
  await db?.end();
  await fixture?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

interface Envelope {
  meta: { status: string; error: { code: string; message: string } | null };
  result: Record<string, unknown> | null;
}

async function seed(body: PlaybookVersion): Promise<string> {
  const id = newPlaybookId();
  await playbooks.create({ id, url: body.steps[0]?.url ?? fixture.url, instruction: 'sec test', createdBy: 'manual', runId: null, body });
  return id;
}

async function submitTo(app: FastifyInstance, payload: object): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/runs', payload });
  expect(res.statusCode).toBe(202);
  return (res.json() as { meta: { run_id: string } }).meta.run_id;
}

async function pollTo(app: FastifyInstance, runId: string): Promise<Envelope> {
  const start = Date.now();
  for (;;) {
    const env = (await app.inject({ method: 'GET', url: `/v1/runs/${runId}` })).json() as Envelope;
    if (['completed', 'completed_with_extraction_errors', 'failed'].includes(env.meta.status)) return env;
    if (Date.now() - start > 20_000) throw new Error(`no terminal: ${JSON.stringify(env.meta)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const lookup = (firstGoto: string): PlaybookVersion => ({
  version: 1,
  engine_min_version: '1.0.0',
  playbook_type: 'extraction',
  output_format: { license_status: 'string' },
  required_data_keys: ['license_number', 'last_name'],
  steps: [
    { op: 'goto', url: firstGoto },
    { op: 'fill', selector: '#licNum', value: '{{data.license_number}}' },
    { op: 'fill', selector: '#lastNm', value: '{{data.last_name}}' },
    { op: 'click', selector: '#submit' },
    { op: 'wait_for', selector: '.results-table' },
    { op: 'extract', schema_ref: 'output_format', scope_selector: '.results-table', fields: { license_status: '.status' } },
  ],
});

describe('Phase 7 — SSRF on the replay path (ARCHITECTURE §9)', () => {
  it('a playbook whose goto targets cloud metadata is blocked with navigation_failed', async () => {
    const id = await seed(lookup('http://169.254.169.254/latest/meta-data'));
    const env = await pollTo(denyApp, await submitTo(denyApp, { playbook_id: id, data: { license_number: 'x', last_name: 'y' } }));
    expect(env.meta.status).toBe('failed');
    expect(env.meta.error?.code).toBe('navigation_failed');
    expect(env.meta.error?.message).toMatch(/private|internal/i);
  });

  it('a private-IP goto is blocked even though the fixture (127.0.0.1) is allowed with the opt-in', async () => {
    const id = await seed(lookup('http://10.0.0.5/lookup'));
    const env = await pollTo(denyApp, await submitTo(denyApp, { playbook_id: id, data: { license_number: 'x', last_name: 'y' } }));
    expect(env.meta.status).toBe('failed');
    expect(env.meta.error?.code).toBe('navigation_failed');
  });
});

describe('Phase 7 — data no-leak scan (PROJECT_SPEC §13)', () => {
  it('a sentinel data value never appears in logs, the run row, or the playbook body', async () => {
    const SENTINEL = 'CANARY-LEAK-9Z7Q-DO-NOT-LOG';
    const id = await seed(lookup(`${fixture.url}/lookup`));

    // Capture everything written to stdout (where pino logs) for the duration of the run.
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;

    let runId = '';
    try {
      runId = await submitTo(allowApp, { playbook_id: id, data: { license_number: SENTINEL, last_name: 'Nguyen' } });
      const env = await pollTo(allowApp, runId);
      expect(env.meta.status).toBe('completed');
    } finally {
      process.stdout.write = origWrite;
    }

    // Logs: the sentinel must not have been written anywhere.
    expect(captured).not.toContain(SENTINEL);

    // Run row: stores data KEYS, not values; data_values null by default (STORE_RUN_INPUTS off).
    const row = (await db.query('SELECT * FROM runs WHERE id = $1', [runId])).rows[0];
    expect(JSON.stringify(row)).not.toContain(SENTINEL);
    expect((row as { data_keys: string[] }).data_keys).toContain('license_number');
    expect((row as { data_values: unknown }).data_values).toBeNull();

    // Playbook body: only `{{data.*}}` refs, never the raw value.
    const body = await playbooks.loadVersion(id, 1);
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
    expect(JSON.stringify(body)).toContain('{{data.license_number}}');
  });
});

describe('Phase 7 — playbooks are data, never code (PROJECT_SPEC §13)', () => {
  it('the playbook schema rejects anything outside the fixed op vocabulary', () => {
    expect(() =>
      parsePlaybookVersion({
        version: 1,
        engine_min_version: '1.0.0',
        playbook_type: 'action',
        required_data_keys: [],
        steps: [{ op: 'eval', code: "require('child_process').exec('rm -rf /')" }],
      }),
    ).toThrow(); // 'eval' is not in the op enum; strict schema also drops the `code` field
  });

  it('the replay interpreter source contains no eval / Function constructor', async () => {
    for (const f of ['runner.ts', 'step-interpreter.ts', 'structural-extractor.ts']) {
      const src = await readFile(join(process.cwd(), 'src/execution/playbook', f), 'utf8');
      expect(src, f).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
    }
  });
});
