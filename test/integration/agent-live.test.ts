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
import { buildServer } from '../../src/transport/http-server';
import { newPlaybookId } from '../../src/shared/ids';
import type { PlaybookVersion } from '../../src/execution/playbook/playbook-schema';

/**
 * THE Phase-4 release-blocker, full form: a real agent LEARNS a task from an instruction, compiles a
 * playbook, and that playbook REPLAYS with different data and no LLM. Opt-in — runs only with a live
 * model key (DECISIONS #22). Offline CI proves the compile→replay half (agent-compile-replay.test).
 *
 *   ANTHROPIC_API_KEY=sk-... AGENT_MODEL=anthropic/claude-sonnet-4-6 npm run test:live
 */
const RUN_LIVE = Boolean(process.env.ANTHROPIC_API_KEY);
const MODEL = process.env.AGENT_MODEL ?? 'anthropic/claude-sonnet-4-6';
const FALLBACK_MODEL = process.env.FALLBACK_MODEL ?? 'anthropic/claude-haiku-4-5';
const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';
const suite = RUN_LIVE ? describe : describe.skip;

let fixture: FixtureHandle;
let db: Db;
let app: FastifyInstance;
let pool: BrowserPool;
let playbooks: PlaybookRepository;
let tmp: string;

beforeAll(async () => {
  if (!RUN_LIVE) return;
  fixture = await startFixture();
  tmp = await mkdtemp(join(tmpdir(), 'rote-agentlive-'));
  // Agent runs hit the fixture on 127.0.0.1 — permit private hosts for this local run only.
  const nodeEnv: NodeJS.ProcessEnv = { ...process.env, ALLOW_PRIVATE_TARGETS: 'true' };
  const env = loadEnvConfig({ DATABASE_URL: TEST_DB, STORAGE_LOCAL_PATH: tmp, PORT: '0', ALLOW_PRIVATE_TARGETS: 'true' } as NodeJS.ProcessEnv);
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
    agentEngine: new AgentEngine({ evidence, selectorCache: new LocalSelectorCache(env.storageLocalPath), env: nodeEnv }),
    fallback: new ModelGatewayFallback(new ModelGateway(nodeEnv)),
  });
  app = buildServer({ db, orchestrator, playbooks, evidence, lifecycle });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.shutdown();
  await db?.end();
  await fixture?.close();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

interface Envelope {
  meta: {
    status: string;
    mode: string | null;
    playbook_id: string | null;
    playbook_version: number | null;
    self_healed: boolean;
    llm_fallback_used: boolean;
    fallback_fields: string[] | null;
  };
  result: Record<string, unknown> | null;
}

async function submit(payload: object): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/runs', payload });
  expect(res.statusCode).toBe(202);
  return (res.json() as { meta: { run_id: string } }).meta.run_id;
}

async function poll(runId: string, timeoutMs = 180_000): Promise<Envelope> {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: 'GET', url: `/v1/runs/${runId}` });
    const body = res.json() as Envelope;
    if (['completed', 'completed_with_extraction_errors', 'failed'].includes(body.meta.status)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`run did not terminate: ${JSON.stringify(body.meta)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

suite('Phase 4 — learn → replay round-trip (LIVE agent)', () => {
  it(
    'learns a lookup from an instruction, then replays the compiled playbook with different data, no LLM',
    async () => {
      // LEARN (agent, real model).
      const learnRunId = await submit({
        instruction: 'Look up a license: type the license number and last name into the form and search.',
        url: `${fixture.url}/lookup`,
        data: { license_number: 'A123456', last_name: 'Nguyen' },
        output_format: { license_status: 'string', holder_name: 'string', expiry_date: 'string (ISO date)' },
        config: { model: MODEL },
      });
      const learn = await poll(learnRunId);
      expect(learn.meta.status).toBe('completed');
      expect(learn.meta.mode).toBe('agent');
      expect(learn.meta.playbook_id).toBeTruthy();
      expect(learn.meta.playbook_version).toBe(1);
      expect(learn.result).toMatchObject({ license_status: 'active', holder_name: 'NGUYEN, A123456' });

      // REPLAY the compiled playbook with DIFFERENT data — deterministic, zero LLM.
      const playbookId = learn.meta.playbook_id as string;
      const replay = await poll(
        await submit({ playbook_id: playbookId, data: { license_number: 'Z999000', last_name: 'Okonkwo' } }),
        30_000,
      );
      expect(replay.meta.status).toBe('completed');
      expect(replay.meta.mode).toBe('playbook');
      expect(replay.result).toMatchObject({ license_status: 'active', holder_name: 'OKONKWO, Z999000' });
    },
    240_000,
  );
});

async function seedLive(body: PlaybookVersion, url: string): Promise<string> {
  const id = newPlaybookId();
  await playbooks.create({ id, url, instruction: 'look up a license by number and last name, then read the result', createdBy: 'manual', runId: null, body });
  return id;
}

suite('Phase 5 — self-heal & surfaced fallback (LIVE)', () => {
  it(
    'a playbook broken by a site redesign self-heals: replay fails → agent learns v2 → v2 replays cleanly',
    async () => {
      // v1 uses the ORIGINAL selectors but points at the MUTATED /v2 site (renamed selectors) → step_failed.
      const stale: PlaybookVersion = {
        version: 1,
        engine_min_version: '1.0.0',
        playbook_type: 'extraction',
        output_format: { license_status: 'string', holder_name: 'string' },
        required_data_keys: ['license_number', 'last_name'],
        steps: [
          { op: 'goto', url: `${fixture.url}/v2/lookup` },
          { op: 'fill', selector: '#licNum', value: '{{data.license_number}}', timeout_ms: 4000 }, // gone on /v2
          { op: 'fill', selector: '#lastNm', value: '{{data.last_name}}' },
          { op: 'click', selector: '#submit' },
          { op: 'wait_for', selector: '.results-table' },
          { op: 'extract', schema_ref: 'output_format', scope_selector: '.results-table', fields: { license_status: '.status', holder_name: '.holder' } },
        ],
      };
      const id = await seedLive(stale, `${fixture.url}/v2/lookup`);

      const healed = await poll(
        await submit({ playbook_id: id, data: { license_number: 'A123456', last_name: 'Nguyen' }, config: { playbook_self_heal: true, model: MODEL } }),
      );
      expect(healed.meta.status).toBe('completed');
      expect(healed.meta.self_healed).toBe(true);
      expect(healed.meta.mode).toBe('agent');
      expect(healed.meta.playbook_version).toBe(2);
      expect(healed.result).toMatchObject({ license_status: 'active' });

      // v2 (healed) now replays on the mutated site with DIFFERENT data, deterministically, no LLM.
      const replay = await poll(
        await submit({ playbook_id: id, data: { license_number: 'B55', last_name: 'Okonkwo' } }),
        30_000,
      );
      expect(replay.meta.status).toBe('completed');
      expect(replay.meta.mode).toBe('playbook');
      expect(replay.result).toMatchObject({ license_status: 'active', holder_name: 'OKONKWO, B55' });
    },
    240_000,
  );

  it(
    'a structural extraction miss is rescued by the surfaced LLM fallback (Haiku), always counted',
    async () => {
      // Good lookup flow, but the holder_name extract selector is wrong → structural miss on that field.
      const body: PlaybookVersion = {
        version: 1,
        engine_min_version: '1.0.0',
        playbook_type: 'extraction',
        output_format: { license_status: 'string', holder_name: 'string' },
        required_data_keys: ['license_number', 'last_name'],
        steps: [
          { op: 'goto', url: `${fixture.url}/lookup` },
          { op: 'fill', selector: '#licNum', value: '{{data.license_number}}' },
          { op: 'fill', selector: '#lastNm', value: '{{data.last_name}}' },
          { op: 'click', selector: '#submit' },
          { op: 'wait_for', selector: '.results-table' },
          { op: 'extract', schema_ref: 'output_format', scope_selector: '.results-table', fields: { license_status: '.status', holder_name: '.no-such-selector' } },
        ],
      };
      const id = await seedLive(body, `${fixture.url}/lookup`);
      const env = await poll(
        await submit({
          playbook_id: id,
          data: { license_number: 'A123456', last_name: 'Nguyen' },
          config: { replay_llm_fallback: 'on', replay_llm_fallback_model: FALLBACK_MODEL },
        }),
        60_000,
      );
      expect(env.meta.llm_fallback_used).toBe(true);
      expect(env.meta.fallback_fields).toContain('holder_name');
      expect(env.meta.status).toBe('completed');
      expect(String(env.result?.holder_name)).toContain('NGUYEN');
    },
    120_000,
  );
});
