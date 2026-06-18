import { loadEnvConfig } from '../src/shared/env';
import { createDb } from '../src/persistence/db';
import { LocalPlaybookStore } from '../src/persistence/playbooks/store.local';
import { PlaybookRepository } from '../src/persistence/playbooks/repository';
import { newPlaybookId } from '../src/shared/ids';
import type { PlaybookVersion } from '../src/execution/playbook/playbook-schema';

/**
 * Phase 5 in-Docker gate: self-heal + surfaced fallback against the DOCKERIZED engine over HTTP.
 * Seeds a stale playbook (old selectors on the mutated /v2 site) and a miss playbook, then drives a
 * heal (replay fails → agent learns v2 in-container → v2 replays) and a fallback (Haiku rescues a
 * missing field in-container). Requires the engine up with a funded ANTHROPIC_API_KEY. Run on the host:
 *   docker compose up --build -d
 *   FIXTURE_URL=http://fixture:3100 DATABASE_URL=postgres://rote:rote@localhost:5433/rote \
 *     STORAGE_LOCAL_PATH=./data npx tsx scripts/docker-heal-check.ts
 */
const BASE = process.env.ENGINE_URL ?? 'http://localhost:8080';
const FIXTURE_URL = process.env.FIXTURE_URL ?? 'http://fixture:3100';
const HEAL_MODEL = process.env.AGENT_MODEL ?? 'anthropic/claude-sonnet-4-6';
const FALLBACK_MODEL = process.env.FALLBACK_MODEL ?? 'anthropic/claude-haiku-4-5';

interface Envelope {
  meta: { status: string; mode: string | null; self_healed: boolean; llm_fallback_used: boolean; fallback_fields: string[] | null; playbook_version: number | null; error?: { code: string; heal_outcome?: string } | null };
  result: Record<string, unknown> | null;
}

async function repo(): Promise<PlaybookRepository> {
  const env = loadEnvConfig();
  return new PlaybookRepository(createDb(env), new LocalPlaybookStore(env.storageLocalPath));
}

async function submit(payload: object): Promise<string> {
  const res = await fetch(`${BASE}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.status !== 202) throw new Error(`submit ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { meta: { run_id: string } }).meta.run_id;
}

async function poll(runId: string, timeoutMs = 180_000): Promise<Envelope> {
  const start = Date.now();
  for (;;) {
    const body = (await (await fetch(`${BASE}/v1/runs/${runId}`)).json()) as Envelope;
    if (['completed', 'completed_with_extraction_errors', 'failed'].includes(body.meta.status)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`run did not terminate: ${JSON.stringify(body.meta)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function staleV2(): PlaybookVersion {
  return {
    version: 1, engine_min_version: '1.0.0', playbook_type: 'extraction',
    output_format: { license_status: 'string', holder_name: 'string' },
    required_data_keys: ['license_number', 'last_name'],
    steps: [
      { op: 'goto', url: `${FIXTURE_URL}/v2/lookup` },
      { op: 'fill', selector: '#licNum', value: '{{data.license_number}}', timeout_ms: 4000 },
      { op: 'fill', selector: '#lastNm', value: '{{data.last_name}}' },
      { op: 'click', selector: '#submit' },
      { op: 'wait_for', selector: '.results-table' },
      { op: 'extract', schema_ref: 'output_format', scope_selector: '.results-table', fields: { license_status: '.status', holder_name: '.holder' } },
    ],
  };
}

function missPlaybook(): PlaybookVersion {
  return {
    version: 1, engine_min_version: '1.0.0', playbook_type: 'extraction',
    output_format: { license_status: 'string', holder_name: 'string' },
    required_data_keys: ['license_number', 'last_name'],
    steps: [
      { op: 'goto', url: `${FIXTURE_URL}/lookup` },
      { op: 'fill', selector: '#licNum', value: '{{data.license_number}}' },
      { op: 'fill', selector: '#lastNm', value: '{{data.last_name}}' },
      { op: 'click', selector: '#submit' },
      { op: 'wait_for', selector: '.results-table' },
      { op: 'extract', schema_ref: 'output_format', scope_selector: '.results-table', fields: { license_status: '.status', holder_name: '.no-such' } },
    ],
  };
}

async function main(): Promise<void> {
  const r = await repo();
  const healId = newPlaybookId();
  await r.create({ id: healId, url: `${FIXTURE_URL}/v2/lookup`, instruction: 'look up a license by number and last name, then read the result', createdBy: 'manual', runId: null, body: staleV2() });
  const missId = newPlaybookId();
  await r.create({ id: missId, url: `${FIXTURE_URL}/lookup`, instruction: 'look up a license', createdBy: 'manual', runId: null, body: missPlaybook() });

  process.stdout.write('SELF-HEAL (in-container)...\n');
  const heal = await poll(await submit({ playbook_id: healId, data: { license_number: 'A123456', last_name: 'Nguyen' }, config: { playbook_self_heal: true, model: HEAL_MODEL } }));
  process.stdout.write(`  heal: status=${heal.meta.status} self_healed=${heal.meta.self_healed} version=${heal.meta.playbook_version} result=${JSON.stringify(heal.result)}\n`);
  const healOk = heal.meta.status === 'completed' && heal.meta.self_healed && heal.meta.playbook_version === 2;
  if (!healOk) { process.stdout.write(`FAIL: heal (error=${JSON.stringify(heal.meta.error)})\n`); process.exit(1); }

  process.stdout.write('FALLBACK (in-container)...\n');
  const fb = await poll(await submit({ playbook_id: missId, data: { license_number: 'A123456', last_name: 'Nguyen' }, config: { replay_llm_fallback: 'on', replay_llm_fallback_model: FALLBACK_MODEL } }), 60_000);
  process.stdout.write(`  fallback: status=${fb.meta.status} used=${fb.meta.llm_fallback_used} fields=${JSON.stringify(fb.meta.fallback_fields)} result=${JSON.stringify(fb.result)}\n`);
  const fbOk = fb.meta.llm_fallback_used && (fb.meta.fallback_fields ?? []).includes('holder_name') && String(fb.result?.holder_name).includes('NGUYEN');
  if (!fbOk) { process.stdout.write('FAIL: fallback did not surface/resolve\n'); process.exit(1); }

  process.stdout.write('IN-DOCKER HEAL + FALLBACK: PASS\n');
}

main().catch((err: unknown) => { process.stderr.write(`docker heal check failed: ${String(err)}\n`); process.exit(1); });
