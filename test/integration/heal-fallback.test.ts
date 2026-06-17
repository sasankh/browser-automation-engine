import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import { RunOrchestrator } from '../../src/orchestrator/run-orchestrator';
import { buildServer } from '../../src/transport/http-server';
import { newPlaybookId } from '../../src/shared/ids';
import type { AgentRunner, AgentRunInput } from '../../src/execution/agent/agent-engine';
import type { AgentLearnResult } from '../../src/execution/agent/recorded-action';
import type { LlmExtractFallback, FallbackRequest, FallbackResponse } from '../../src/execution/playbook/llm-fallback';
import type { PlaybookVersion } from '../../src/execution/playbook/playbook-schema';

// Heal + fallback deterministic logic, proven offline by injecting a FAKE agent (heal) and FAKE
// fallback (no LLM). The full live mutate→heal + fallback round-trip is the opt-in agent-live test.
const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';

// Per-test controllable fakes.
let agentBehavior: (input: AgentRunInput) => Promise<AgentLearnResult>;
let fallbackBehavior: (req: FallbackRequest) => Promise<FallbackResponse>;
let agentCalls = 0;
let fallbackCalls = 0;
const fakeAgent: AgentRunner = { run: (input) => (agentCalls++, agentBehavior(input)) };
const fakeFallback: LlmExtractFallback = { extract: (req) => (fallbackCalls++, fallbackBehavior(req)) };

let fixture: FixtureHandle;
let db: Db;
let app: FastifyInstance;
let playbooks: PlaybookRepository;
let pool: BrowserPool;
let tmp: string;

beforeAll(async () => {
  fixture = await startFixture();
  tmp = await mkdtemp(join(tmpdir(), 'rote-heal-'));
  // Dummy key so model resolution passes (the fakes replace every real model call); threshold=3.
  const nodeEnv: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: 'sk-test-offline', HEAL_FAILURE_THRESHOLD: '3' };
  const env = loadEnvConfig({ DATABASE_URL: TEST_DB, STORAGE_LOCAL_PATH: tmp, PORT: '0', HEAL_FAILURE_THRESHOLD: '3' } as NodeJS.ProcessEnv);
  db = createDb(env);
  await runMigrations(db);
  playbooks = new PlaybookRepository(db, new LocalPlaybookStore(env.storageLocalPath));
  const evidence = new LocalEvidenceStore(env.storageLocalPath);
  pool = new BrowserPool(env.browserRecycleRuns);
  const lifecycle = new Lifecycle(pool, env.maxConcurrentRuns, env.maxQueueDepth);
  const orchestrator = new RunOrchestrator({
    env,
    nodeEnv,
    runs: new RunStore(db),
    idempotency: new IdempotencyGuard(db),
    playbooks,
    runner: new PlaybookRunner(evidence),
    lifecycle,
    modelGateway: new ModelGateway(nodeEnv),
    agentEngine: fakeAgent,
    fallback: fakeFallback,
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

beforeEach(() => {
  agentCalls = 0;
  fallbackCalls = 0;
  agentBehavior = () => Promise.reject(new Error('agent behavior not set'));
  fallbackBehavior = () => Promise.resolve({ resolved: {} });
});

interface Envelope {
  meta: {
    status: string;
    mode: string | null;
    self_healed: boolean;
    llm_fallback_used: boolean;
    fallback_fields: string[] | null;
    playbook_version: number | null;
    error: { code: string; heal_attempted?: boolean; heal_outcome?: string } | null;
  };
  result: Record<string, unknown> | null;
}

async function submit(payload: object): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/runs', payload });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(202);
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

async function getPlaybook(id: string): Promise<{ active_version: number; health: string }> {
  return (await app.inject({ method: 'GET', url: `/v1/playbooks/${id}` })).json() as { active_version: number; health: string };
}

/** A lookup playbook; pass a bad selector + short timeout to force a step_failed, or a bad extract field. */
function lookupPlaybook(opts: { badStep?: boolean; badField?: boolean }): PlaybookVersion {
  return {
    version: 1,
    engine_min_version: '1.0.0',
    playbook_type: 'extraction',
    output_format: { license_status: 'string', holder_name: 'string', expiry_date: 'string (ISO date)' },
    required_data_keys: ['license_number', 'last_name'],
    steps: [
      { op: 'goto', url: `${fixture.url}/lookup` },
      { op: 'fill', selector: '#licNum', value: '{{data.license_number}}' },
      { op: 'fill', selector: '#lastNm', value: '{{data.last_name}}' },
      { op: 'click', selector: opts.badStep ? '#does-not-exist' : '#submit', timeout_ms: opts.badStep ? 500 : undefined },
      { op: 'wait_for', selector: '.results-table' },
      {
        op: 'extract',
        schema_ref: 'output_format',
        scope_selector: '.results-table',
        fields: {
          license_status: '.status',
          holder_name: '.holder',
          expiry_date: opts.badField ? '.no-such-field' : '.expiry',
        },
      },
    ],
  };
}

/** What the fake agent returns on a successful heal — a valid recording + a result. */
function healSuccess(): AgentLearnResult {
  return {
    recorded: [
      { op: 'goto', url: `${fixture.url}/lookup` },
      { op: 'fill', selector: '#licNum', value: 'X', dataProvenance: 'license_number' },
      { op: 'fill', selector: '#lastNm', value: 'Y', dataProvenance: 'last_name' },
      { op: 'click', selector: '#submit' },
      { op: 'wait_for', selector: '.results-table' },
    ],
    extractionFields: { license_status: '.status', holder_name: '.holder', expiry_date: '.expiry' },
    scopeSelector: '.results-table',
    result: { license_status: 'active', holder_name: 'HEALED, A1', expiry_date: '2027-12-31' },
    extractionErrors: [],
    usage: { inputTokens: 100, outputTokens: 10 },
  };
}

async function seed(body: PlaybookVersion): Promise<string> {
  const id = newPlaybookId();
  await playbooks.create({
    id,
    url: `${fixture.url}/lookup`,
    instruction: 'look up a license',
    createdBy: 'manual',
    runId: null,
    body,
  });
  return id;
}

const DATA = { license_number: 'A1', last_name: 'Nguyen' };

describe('Phase 5 — surfaced LLM extraction fallback (offline, fake fallback)', () => {
  it('engages on a structural miss when on, resolves the field, and is always surfaced', async () => {
    const id = await seed(lookupPlaybook({ badField: true })); // expiry_date selector is wrong
    fallbackBehavior = () => Promise.resolve({ resolved: { expiry_date: '2099-12-31' } });
    const env = await poll(
      await submit({ playbook_id: id, data: DATA, config: { replay_llm_fallback: 'on', replay_llm_fallback_model: 'anthropic/claude-haiku-4-5' } }),
    );
    expect(env.meta.status).toBe('completed'); // fallback filled the gap → completed
    expect(env.meta.llm_fallback_used).toBe(true);
    expect(env.meta.fallback_fields).toEqual(['expiry_date']);
    expect(env.result).toMatchObject({ license_status: 'active', expiry_date: '2099-12-31' });
    expect(fallbackCalls).toBe(1);
  });

  it('with fallback off, the same miss is completed_with_extraction_errors and never calls the model', async () => {
    const id = await seed(lookupPlaybook({ badField: true }));
    const env = await poll(await submit({ playbook_id: id, data: DATA })); // fallback off (default)
    expect(env.meta.status).toBe('completed_with_extraction_errors');
    expect(env.meta.llm_fallback_used).toBe(false);
    expect(env.result?.expiry_date).toBeNull();
    expect(fallbackCalls).toBe(0);
  });
});

describe('Phase 5 — self-heal (offline, fake agent)', () => {
  it('a step_failed heals: same run continues in agent mode → v2, self_healed', async () => {
    const id = await seed(lookupPlaybook({ badStep: true }));
    agentBehavior = () => Promise.resolve(healSuccess());
    const env = await poll(await submit({ playbook_id: id, data: DATA, config: { playbook_self_heal: true, model: 'anthropic/claude-sonnet-4-6' } }));
    expect(env.meta.status).toBe('completed');
    expect(env.meta.self_healed).toBe(true);
    expect(env.meta.mode).toBe('agent');
    expect(env.meta.playbook_version).toBe(2);
    expect(env.result).toMatchObject({ holder_name: 'HEALED, A1' });
    expect(agentCalls).toBe(1);
    const pb = await getPlaybook(id);
    expect(pb.active_version).toBe(2);
    expect(pb.health).toBe('healthy');
  });

  it('respects config: with playbook_self_heal=false the failure is returned, heal_attempted:false', async () => {
    const id = await seed(lookupPlaybook({ badStep: true }));
    const env = await poll(await submit({ playbook_id: id, data: DATA, config: { playbook_self_heal: false } }));
    expect(env.meta.status).toBe('failed');
    expect(env.meta.error?.code).toBe('step_failed');
    expect(env.meta.error?.heal_attempted).toBe(false);
    expect(agentCalls).toBe(0);
  });

  it('extraction miss escalates to heal only when self_heal_on_extraction_failure (fallback-first-then-heal)', async () => {
    const id = await seed(lookupPlaybook({ badField: true }));
    agentBehavior = () => Promise.resolve(healSuccess());
    const env = await poll(
      await submit({
        playbook_id: id,
        data: DATA,
        config: { playbook_self_heal: true, self_heal_on_extraction_failure: true, model: 'anthropic/claude-sonnet-4-6' },
      }),
    );
    expect(env.meta.self_healed).toBe(true);
    expect(env.meta.playbook_version).toBe(2);
    expect(agentCalls).toBe(1);
  });

  it('repeated heal failures flag health=unhealthy at the threshold, surfaced via ?health=unhealthy', async () => {
    const id = await seed(lookupPlaybook({ badStep: true }));
    agentBehavior = () => Promise.reject(new Error('agent could not heal'));
    const cfg = { playbook_self_heal: true, model: 'anthropic/claude-sonnet-4-6' };
    for (let i = 0; i < 3; i++) {
      const env = await poll(await submit({ playbook_id: id, data: DATA, config: cfg }));
      expect(env.meta.status).toBe('failed');
      expect(env.meta.error?.heal_attempted).toBe(true);
    }
    expect((await getPlaybook(id)).health).toBe('unhealthy');
    const list = (await app.inject({ method: 'GET', url: '/v1/playbooks?health=unhealthy' })).json() as { playbooks: Array<{ playbook_id: string }> };
    expect(list.playbooks.some((p) => p.playbook_id === id)).toBe(true);
  });

  it('a pinned-version run that heals writes a NEW version, never overwriting a slot', async () => {
    const id = await seed(lookupPlaybook({ badStep: true })); // v1 fails
    await playbooks.addVersion(id, lookupPlaybook({}), 'manual', null); // v2 (active)
    agentBehavior = () => Promise.resolve(healSuccess());
    const env = await poll(
      await submit({ playbook_id: id, playbook_version: 1, data: DATA, config: { playbook_self_heal: true, model: 'anthropic/claude-sonnet-4-6' } }),
    );
    expect(env.meta.self_healed).toBe(true);
    expect(env.meta.playbook_version).toBe(3); // active(2) + 1 — v1 and v2 untouched
    expect((await getPlaybook(id)).active_version).toBe(3);
    expect(await playbooks.loadVersion(id, 1)).not.toBeNull(); // pinned slot intact
  });
});
