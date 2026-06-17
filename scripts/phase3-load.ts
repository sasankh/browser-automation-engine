import { loadEnvConfig } from '../src/shared/env';
import { createDb } from '../src/persistence/db';
import { LocalPlaybookStore } from '../src/persistence/playbooks/store.local';
import { PlaybookRepository } from '../src/persistence/playbooks/repository';
import { newPlaybookId } from '../src/shared/ids';
import type { PlaybookVersion } from '../src/execution/playbook/playbook-schema';

/**
 * Phase 3 cold-start load + isolation gate, driven over the REAL HTTP boundary against the
 * dockerized engine (not vitest's in-process app). Seeds an isolation playbook into the shared
 * data volume + Postgres index, then fires `LOAD_SEQUENTIAL` sequential + `LOAD_CONCURRENT`
 * concurrent replays — each stamping a distinct token into its own browser context and reading it
 * back. Asserts zero cross-contamination and that saturation returns to 0 at idle. Run on the host:
 *
 *   FIXTURE_URL=http://fixture:3100 DATABASE_URL=postgres://rote:rote@localhost:5433/rote \
 *   STORAGE_LOCAL_PATH=./data ENGINE_URL=http://localhost:8080 npx tsx scripts/phase3-load.ts
 */
const BASE = process.env.ENGINE_URL ?? 'http://localhost:8080';
const FIXTURE_URL = process.env.FIXTURE_URL ?? 'http://fixture:3100';
const SEQUENTIAL = Number(process.env.LOAD_SEQUENTIAL ?? 50);
const CONCURRENT = Number(process.env.LOAD_CONCURRENT ?? 10);

interface Envelope {
  meta: { status: string; error?: { code: string } | null };
  result: Record<string, unknown> | null;
}

function isolationPlaybook(): PlaybookVersion {
  return {
    version: 1,
    engine_min_version: '1.0.0',
    playbook_type: 'extraction',
    output_format: { cookie_token: 'string', ls_token: 'string' },
    required_data_keys: ['token'],
    steps: [
      { op: 'goto', url: `${FIXTURE_URL}/iso/set` },
      { op: 'fill', selector: '#token', value: '{{data.token}}' },
      { op: 'click', selector: '#apply' },
      { op: 'wait_for', selector: '.done' },
      { op: 'goto', url: `${FIXTURE_URL}/iso/read` },
      { op: 'wait_for', selector: '.ls-token' },
      { op: 'extract', schema_ref: 'output_format', fields: { cookie_token: '.cookie-token', ls_token: '.ls-token' } },
    ],
  };
}

async function seed(): Promise<string> {
  const env = loadEnvConfig();
  const db = createDb(env);
  const repo = new PlaybookRepository(db, new LocalPlaybookStore(env.storageLocalPath));
  const id = newPlaybookId();
  await repo.create({
    id,
    url: `${FIXTURE_URL}/iso/set`,
    instruction: 'phase-3 isolation load',
    createdBy: 'manual',
    runId: null,
    body: isolationPlaybook(),
  });
  await db.end();
  return id;
}

async function submit(id: string, token: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playbook_id: id, data: { token }, config: { evidence_capture: false } }),
  });
  if (res.status !== 202) throw new Error(`submit returned ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { meta: { run_id: string } };
  return body.meta.run_id;
}

async function poll(runId: string, timeoutMs = 60_000): Promise<Envelope> {
  const start = Date.now();
  for (;;) {
    const res = await fetch(`${BASE}/v1/runs/${runId}`);
    const body = (await res.json()) as Envelope;
    if (['completed', 'completed_with_extraction_errors', 'failed'].includes(body.meta.status)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} did not terminate`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function health(): Promise<{ runs_in_progress: number; queue_depth: number }> {
  const res = await fetch(`${BASE}/v1/health`);
  return (await res.json()) as { runs_in_progress: number; queue_depth: number };
}

async function runOne(id: string, token: string): Promise<string | null> {
  const env = await poll(await submit(id, token));
  if (env.meta.status !== 'completed') return `${token}: status=${env.meta.status} error=${JSON.stringify(env.meta.error)}`;
  if (env.result?.cookie_token !== token || env.result?.ls_token !== token) {
    return `${token}: CONTAMINATED result=${JSON.stringify(env.result)}`;
  }
  return null;
}

async function main(): Promise<void> {
  const id = await seed();
  process.stdout.write(`seeded isolation playbook ${id}\n`);
  const failures: string[] = [];
  let n = 0;

  process.stdout.write(`sequential x${SEQUENTIAL}...\n`);
  for (let i = 0; i < SEQUENTIAL; i++) {
    const f = await runOne(id, `seq-${n++}`);
    if (f) failures.push(f);
  }

  process.stdout.write(`concurrent x${CONCURRENT}...\n`);
  const tokens = Array.from({ length: CONCURRENT }, () => `con-${n++}`);
  const results = await Promise.all(tokens.map((t) => runOne(id, t)));
  for (const f of results) if (f) failures.push(f);

  // Saturation must return to 0 at idle (no slot leaks).
  const start = Date.now();
  let h = await health();
  while ((h.runs_in_progress !== 0 || h.queue_depth !== 0) && Date.now() - start < 30_000) {
    await new Promise((r) => setTimeout(r, 200));
    h = await health();
  }

  process.stdout.write(
    `\nDONE: ${SEQUENTIAL + CONCURRENT} runs, ${failures.length} failures; idle saturation=${JSON.stringify(h)}\n`,
  );
  if (failures.length > 0) {
    process.stdout.write(`FAILURES:\n${failures.slice(0, 20).join('\n')}\n`);
    process.exit(1);
  }
  if (h.runs_in_progress !== 0 || h.queue_depth !== 0) {
    process.stdout.write('FAIL: saturation did not return to 0 (possible slot leak)\n');
    process.exit(1);
  }
  process.stdout.write('PASS: zero cross-contamination, slots reclaimed\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`load gate failed: ${String(err)}\n`);
  process.exit(1);
});
