import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import { startFixture, type FixtureHandle } from '../fixtures/site/server';
import { loadEnvConfig } from '../../src/shared/env';
import { makeS3Client } from '../../src/persistence/aws';
import { createDb, type Db } from '../../src/persistence/db';
import { runMigrations } from '../../src/persistence/migrate';
import { RunStore } from '../../src/persistence/runs/run-store.pg';
import { IdempotencyGuard } from '../../src/intake/idempotency';
import { S3PlaybookStore } from '../../src/persistence/playbooks/store.s3';
import { PlaybookRepository } from '../../src/persistence/playbooks/repository';
import { S3EvidenceStore } from '../../src/persistence/evidence/evidence.s3';
import { S3SelectorCache } from '../../src/persistence/cache/selector-cache.s3';
import { PlaybookRunner } from '../../src/execution/playbook/runner';
import { BrowserPool } from '../../src/browser/pool';
import { Lifecycle } from '../../src/orchestrator/lifecycle';
import { ModelGateway } from '../../src/model/model-gateway';
import { AgentEngine } from '../../src/execution/agent/agent-engine';
import { ModelGatewayFallback } from '../../src/execution/playbook/llm-fallback';
import { RunOrchestrator } from '../../src/orchestrator/run-orchestrator';
import { buildServer } from '../../src/transport/http-server';
import { newPlaybookId } from '../../src/shared/ids';
import type { PlaybookVersion } from '../../src/execution/playbook/playbook-schema';

// The Phase-6 backend-swap proof: the SAME replay path runs on S3 storage with NO code change above
// persistence (DECISIONS #29). Needs LocalStack. Evidence stays the engine path → 302 to presigned (#31).
const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://rote:rote@localhost:5433/rote';
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const BUCKET = 'rote';

let fixture: FixtureHandle;
let db: Db;
let app: FastifyInstance;
let pool: BrowserPool;
let playbooks: PlaybookRepository;

beforeAll(async () => {
  fixture = await startFixture();
  const env = loadEnvConfig({
    DATABASE_URL: TEST_DB,
    STORAGE_BACKEND: 's3',
    S3_BUCKET: BUCKET,
    AWS_ENDPOINT_URL: ENDPOINT,
    AWS_REGION: 'us-east-1',
    PORT: '0',
    ALLOW_PRIVATE_TARGETS: 'true',
  } as NodeJS.ProcessEnv);
  const s3 = makeS3Client(env);
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
  db = createDb(env);
  await runMigrations(db);
  // S3 storage adapters, chosen exactly as index.ts would for STORAGE_BACKEND=s3.
  playbooks = new PlaybookRepository(db, new S3PlaybookStore(s3, BUCKET));
  const evidence = new S3EvidenceStore(s3, BUCKET);
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
    agentEngine: new AgentEngine({ evidence, selectorCache: new S3SelectorCache(s3, BUCKET), env: process.env }),
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
});

interface Envelope {
  meta: { status: string; evidence: { screenshot_url: string | null } | null };
  result: Record<string, unknown> | null;
}

function lookupPlaybook(): PlaybookVersion {
  return {
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
      { op: 'extract', schema_ref: 'output_format', scope_selector: '.results-table', fields: { license_status: '.status', holder_name: '.holder' } },
    ],
  };
}

async function poll(runId: string): Promise<Envelope> {
  const start = Date.now();
  for (;;) {
    const env = (await app.inject({ method: 'GET', url: `/v1/runs/${runId}` })).json() as Envelope;
    if (['completed', 'completed_with_extraction_errors', 'failed'].includes(env.meta.status)) return env;
    if (Date.now() - start > 30_000) throw new Error(`no terminal: ${JSON.stringify(env.meta)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('Phase 6 — backend swap to S3 (LocalStack)', () => {
  it('a playbook stored in S3 replays correctly, and evidence 302-redirects to a presigned S3 URL', async () => {
    const id = newPlaybookId();
    await playbooks.create({ id, url: `${fixture.url}/lookup`, instruction: 'lookup', createdBy: 'manual', runId: null, body: lookupPlaybook() });

    const sub = await app.inject({ method: 'POST', url: '/v1/runs', payload: { playbook_id: id, data: { license_number: 'S3-1', last_name: 'Nguyen' } } });
    expect(sub.statusCode).toBe(202);
    const runId = (sub.json() as { meta: { run_id: string } }).meta.run_id;

    const env = await poll(runId);
    expect(env.meta.status).toBe('completed');
    expect(env.result).toMatchObject({ license_status: 'active', holder_name: 'NGUYEN, S3-1' });

    // Evidence URL is the stable engine path; in S3 mode it 302s to a presigned URL that resolves.
    expect(env.meta.evidence?.screenshot_url).toBe(`/v1/runs/${runId}/evidence/screenshot.png`);
    const redirect = await app.inject({ method: 'GET', url: `/v1/runs/${runId}/evidence/screenshot.png` });
    expect(redirect.statusCode).toBe(302);
    const location = redirect.headers.location as string;
    expect(location).toContain('screenshot.png');
    const fetched = await fetch(location);
    expect(fetched.status).toBe(200);
    expect((await fetched.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
