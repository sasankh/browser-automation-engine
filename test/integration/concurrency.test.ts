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
import { RunOrchestrator } from '../../src/orchestrator/run-orchestrator';
import { buildServer } from '../../src/transport/http-server';
import { newPlaybookId } from '../../src/shared/ids';
import type { PlaybookVersion } from '../../src/execution/playbook/playbook-schema';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';

// The release-blocking isolation test is HEAVY by default (the single most important test in the
// project — ARCHITECTURE §8.1). Crank it further in CI via ISO_CONCURRENCY / ISO_ROUNDS.
const ISO_CONCURRENCY = Number(process.env.ISO_CONCURRENCY ?? 12);
const ISO_ROUNDS = Number(process.env.ISO_ROUNDS ?? 50);

let fixture: FixtureHandle;
let db: Db;
const openStacks = new Set<Stack>();

/** A full, independently-configured engine stack (own pool/lifecycle/server) over the shared DB. */
interface Stack {
  app: FastifyInstance;
  pool: BrowserPool;
  lifecycle: Lifecycle;
  playbooks: PlaybookRepository;
  close: () => Promise<void>;
}

async function buildStack(overrides: Record<string, string>): Promise<Stack> {
  const tmp = await mkdtemp(join(tmpdir(), 'rote-conc-'));
  const nodeEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: TEST_DB,
    STORAGE_LOCAL_PATH: tmp,
    PORT: '0',
    ...overrides,
  };
  const env = loadEnvConfig(nodeEnv);
  const store = new LocalPlaybookStore(env.storageLocalPath);
  const playbooks = new PlaybookRepository(db, store);
  const evidence = new LocalEvidenceStore(env.storageLocalPath);
  const runner = new PlaybookRunner(evidence);
  const pool = new BrowserPool(env.browserRecycleRuns);
  const lifecycle = new Lifecycle(pool, env.maxConcurrentRuns, env.maxQueueDepth);
  const orchestrator = new RunOrchestrator({
    env,
    nodeEnv,
    runs: new RunStore(db),
    idempotency: new IdempotencyGuard(db),
    playbooks,
    runner,
    lifecycle,
  });
  const app = buildServer({ db, orchestrator, playbooks, evidence, lifecycle });
  await app.ready();
  let closed = false;
  const stack: Stack = {
    app,
    pool,
    lifecycle,
    playbooks,
    close: async () => {
      if (closed) return;
      closed = true;
      openStacks.delete(stack);
      await app.close().catch(() => undefined);
      await pool.shutdown().catch(() => undefined);
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    },
  };
  openStacks.add(stack);
  return stack;
}

beforeAll(async () => {
  fixture = await startFixture();
  const env = loadEnvConfig({ DATABASE_URL: TEST_DB, STORAGE_LOCAL_PATH: '/tmp', PORT: '0' } as NodeJS.ProcessEnv);
  db = createDb(env);
  await runMigrations(db);
});

afterAll(async () => {
  // Safety net — each test closes its own stack; this catches any left open by a failure.
  await Promise.all([...openStacks].map((s) => s.close()));
  await db?.end();
  await fixture?.close();
});

interface Envelope {
  meta: { run_id: string; status: string; mode: string | null; error: { code: string; message: string } | null };
  result: Record<string, unknown> | null;
}

interface Health {
  status: string;
  db: string;
  runs_in_progress: number;
  queue_depth: number;
  max_concurrent_runs: number;
}

interface SubmitRes {
  status: number;
  runId: string;
  retryAfter?: string;
  retryAfterSeconds?: number;
}

async function submit(stack: Stack, payload: object): Promise<SubmitRes> {
  const res = await stack.app.inject({ method: 'POST', url: '/v1/runs', payload });
  const body = res.json() as { meta?: { run_id: string }; error?: { retry_after_seconds?: number } };
  return {
    status: res.statusCode,
    runId: body.meta?.run_id ?? '',
    retryAfter: res.headers['retry-after'] as string | undefined,
    retryAfterSeconds: body.error?.retry_after_seconds,
  };
}

async function poll(stack: Stack, runId: string, timeoutMs = 30_000): Promise<Envelope> {
  const start = Date.now();
  for (;;) {
    const res = await stack.app.inject({ method: 'GET', url: `/v1/runs/${runId}` });
    const body = res.json() as Envelope;
    if (['completed', 'completed_with_extraction_errors', 'failed'].includes(body.meta.status)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`run did not terminate: ${JSON.stringify(body.meta)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function health(stack: Stack): Promise<Health> {
  const res = await stack.app.inject({ method: 'GET', url: '/v1/health' });
  return res.json() as Health;
}

async function waitForIdle(stack: Stack, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const h = await health(stack);
    if (h.runs_in_progress === 0 && h.queue_depth === 0) return;
    if (Date.now() - start > timeoutMs) throw new Error(`stack did not go idle: ${JSON.stringify(h)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Bounded-concurrency driver — mirrors a real client keeping K requests in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await fn(item, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

const NO_EVIDENCE = { evidence_capture: false };

/** Extraction playbook: fill a per-run token into a form, then read its cookie + localStorage back. */
function isolationPlaybook(fixtureUrl: string): PlaybookVersion {
  return {
    version: 1,
    engine_min_version: '1.0.0',
    playbook_type: 'extraction',
    output_format: { cookie_token: 'string', ls_token: 'string' },
    required_data_keys: ['token'],
    steps: [
      { op: 'goto', url: `${fixtureUrl}/iso/set` },
      { op: 'fill', selector: '#token', value: '{{data.token}}' },
      { op: 'click', selector: '#apply' },
      { op: 'wait_for', selector: '.done' },
      { op: 'goto', url: `${fixtureUrl}/iso/read` },
      { op: 'wait_for', selector: '.ls-token' },
      { op: 'extract', schema_ref: 'output_format', fields: { cookie_token: '.cookie-token', ls_token: '.ls-token' } },
    ],
  };
}

/** Action playbook that navigates to a fixture endpoint taking `ms` to respond. */
function slowPlaybook(fixtureUrl: string, ms: number): PlaybookVersion {
  return {
    version: 1,
    engine_min_version: '1.0.0',
    playbook_type: 'action',
    output_format: null,
    required_data_keys: [],
    steps: [
      { op: 'goto', url: `${fixtureUrl}/slow?ms=${ms}` },
      { op: 'wait_for', selector: '.done' },
    ],
  };
}

/** Action playbook that navigates to the never-responding endpoint (to be killed by the wall clock). */
function hangPlaybook(fixtureUrl: string): PlaybookVersion {
  return {
    version: 1,
    engine_min_version: '1.0.0',
    playbook_type: 'action',
    output_format: null,
    required_data_keys: [],
    steps: [
      { op: 'goto', url: `${fixtureUrl}/hang` },
      { op: 'wait_for', selector: '.done' },
    ],
  };
}

async function seed(stack: Stack, body: PlaybookVersion): Promise<string> {
  const id = newPlaybookId();
  await stack.playbooks.create({
    id,
    url: body.steps[0]?.url ?? fixture.url,
    instruction: 'phase-3 test playbook',
    createdBy: 'manual',
    runId: null,
    body,
  });
  return id;
}

describe('Phase 3 — concurrency & request isolation (offline fixture)', () => {
  // THE critical test: many truly-concurrent runs, each stamping a distinct token into its own
  // context's cookie + localStorage, must each read back ONLY their own — zero cross-contamination.
  it(
    `isolation: ${ISO_CONCURRENCY} concurrent × ${ISO_ROUNDS} rounds see only their own cookie + localStorage`,
    async () => {
      const stack = await buildStack({
        MAX_CONCURRENT_RUNS: String(ISO_CONCURRENCY),
        MAX_QUEUE_DEPTH: '2000', // admit everything; the semaphore (not 429) bounds concurrency here
        BROWSER_RECYCLE_RUNS: '100000', // hold recycling constant; recycle has its own test
      });
      try {
        const id = await seed(stack, isolationPlaybook(fixture.url));
        const total = ISO_CONCURRENCY * ISO_ROUNDS;
        const tokens = Array.from({ length: total }, (_, i) => `iso-${i}-${(i * 2654435761) % 1_000_000}`);

        const outcomes = await mapWithConcurrency(tokens, ISO_CONCURRENCY * 2, async (token) => {
          const { status, runId } = await submit(stack, { playbook_id: id, data: { token }, config: NO_EVIDENCE });
          expect(status).toBe(202);
          const env = await poll(stack, runId);
          return { token, env };
        });

        const contaminated = outcomes.filter(
          ({ token, env }) =>
            env.meta.status !== 'completed' ||
            env.result?.cookie_token !== token ||
            env.result?.ls_token !== token,
        );
        expect(contaminated).toEqual([]);
        expect(outcomes).toHaveLength(total);
        await waitForIdle(stack);
      } finally {
        await stack.close();
      }
    },
    180_000,
  );

  it('cap: with MAX_CONCURRENT_RUNS=2, a burst of 10 never runs more than 2 at once', async () => {
    const stack = await buildStack({ MAX_CONCURRENT_RUNS: '2', MAX_QUEUE_DEPTH: '50' });
    try {
      const id = await seed(stack, slowPlaybook(fixture.url, 600));

      const submits = await Promise.all(
        Array.from({ length: 10 }, () => submit(stack, { playbook_id: id, data: {}, config: NO_EVIDENCE })),
      );
      expect(submits.every((s) => s.status === 202)).toBe(true);

      // Sample saturation for the duration of the burst; the semaphore must hold the ceiling at 2.
      let observedMax = 0;
      const start = Date.now();
      for (;;) {
        const h = await health(stack);
        observedMax = Math.max(observedMax, h.runs_in_progress);
        expect(h.runs_in_progress).toBeLessThanOrEqual(2);
        if (h.runs_in_progress === 0 && h.queue_depth === 0 && Date.now() - start > 300) break;
        if (Date.now() - start > 20_000) throw new Error('burst did not drain');
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(observedMax).toBe(2);
    } finally {
      await stack.close();
    }
  });

  it('backpressure: with cap=2 + queue=3, the 6th simultaneous request gets 429 + Retry-After', async () => {
    const stack = await buildStack({ MAX_CONCURRENT_RUNS: '2', MAX_QUEUE_DEPTH: '3' });
    try {
      const id = await seed(stack, slowPlaybook(fixture.url, 1500));

      // Capacity is exactly 5 (2 running + 3 queued); fire 6 at once.
      const results = await Promise.all(
        Array.from({ length: 6 }, () => submit(stack, { playbook_id: id, data: {}, config: NO_EVIDENCE })),
      );
      const accepted = results.filter((r) => r.status === 202);
      const rejected = results.filter((r) => r.status === 429);
      expect(accepted).toHaveLength(5);
      expect(rejected).toHaveLength(1);
      const r = rejected[0];
      expect(r?.retryAfter).toBeDefined();
      expect(r?.retryAfterSeconds ?? 0).toBeGreaterThan(0);

      await waitForIdle(stack);
    } finally {
      await stack.close();
    }
  });

  it('timeout: a wedged run is killed at run_timeout_seconds; its slot is reclaimed', async () => {
    const stack = await buildStack({ MAX_CONCURRENT_RUNS: '1', MAX_QUEUE_DEPTH: '5' });
    try {
      const hangId = await seed(stack, hangPlaybook(fixture.url));

      const { status, runId } = await submit(stack, {
        playbook_id: hangId,
        data: {},
        config: { ...NO_EVIDENCE, run_timeout_seconds: 2 },
      });
      expect(status).toBe(202);
      const env = await poll(stack, runId);
      expect(env.meta.status).toBe('failed');
      expect(env.meta.error?.code).toBe('timeout');

      // Slot reclaimed: a subsequent normal run on the same single-slot stack completes.
      const okId = await seed(stack, slowPlaybook(fixture.url, 100));
      const next = await submit(stack, { playbook_id: okId, data: {}, config: NO_EVIDENCE });
      const okEnv = await poll(stack, next.runId);
      expect(okEnv.meta.status).toBe('completed');
      await waitForIdle(stack);
    } finally {
      await stack.close();
    }
  });

  it('recycle: the Chromium process is recycled after BROWSER_RECYCLE_RUNS runs', async () => {
    const stack = await buildStack({ MAX_CONCURRENT_RUNS: '1', BROWSER_RECYCLE_RUNS: '3', MAX_QUEUE_DEPTH: '5' });
    try {
      const id = await seed(stack, slowPlaybook(fixture.url, 50));

      // Run 1 launches generation 1.
      await poll(stack, (await submit(stack, { playbook_id: id, data: {}, config: NO_EVIDENCE })).runId);
      expect(stack.pool.generation(true)).toBe(1);

      // Runs 2 and 3 fill the quota; run 4's acquire triggers the recycle → generation 2.
      for (let i = 0; i < 3; i++) {
        await poll(stack, (await submit(stack, { playbook_id: id, data: {}, config: NO_EVIDENCE })).runId);
      }
      expect(stack.pool.generation(true)).toBe(2);
      await waitForIdle(stack);
    } finally {
      await stack.close();
    }
  });

  it('drain: rejects new intake with 503 and lets the in-flight run finish', async () => {
    const stack = await buildStack({ MAX_CONCURRENT_RUNS: '2', MAX_QUEUE_DEPTH: '5' });
    try {
      const id = await seed(stack, slowPlaybook(fixture.url, 1200));

      const { status, runId } = await submit(stack, { playbook_id: id, data: {}, config: NO_EVIDENCE });
      expect(status).toBe(202);
      // Wait until the run is genuinely executing so drain actually has something to wait for.
      const start = Date.now();
      while ((await health(stack)).runs_in_progress < 1) {
        if (Date.now() - start > 5_000) throw new Error('run never started');
        await new Promise((r) => setTimeout(r, 20));
      }

      const drainP = stack.lifecycle.drain(8_000);
      // New intake is now rejected; health reports draining.
      const rejected = await submit(stack, { playbook_id: id, data: {}, config: NO_EVIDENCE });
      expect(rejected.status).toBe(503);
      expect((await health(stack)).status).toBe('draining');

      await drainP;
      // The in-flight run was allowed to finish within the grace window.
      const env = await poll(stack, runId);
      expect(env.meta.status).toBe('completed');
    } finally {
      await stack.close();
    }
  });
});
