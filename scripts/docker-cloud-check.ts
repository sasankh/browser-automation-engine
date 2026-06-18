import { loadEnvConfig } from '../src/shared/env';
import { createDb } from '../src/persistence/db';
import { makeS3Client } from '../src/persistence/aws';
import { S3PlaybookStore } from '../src/persistence/playbooks/store.s3';
import { PlaybookRepository } from '../src/persistence/playbooks/repository';
import { newPlaybookId } from '../src/shared/ids';
import type { PlaybookVersion } from '../src/execution/playbook/playbook-schema';

/**
 * Phase 6 cloud-topology e2e gate: prove `api → SQS → worker → S3` end to end against the dockerized
 * split (LocalStack). Seeds a playbook into S3 + Postgres (host-side), POSTs a replay to the `api`
 * task, and polls until the `worker` task has executed it. Run on the host AFTER:
 *   docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build postgres localstack fixture api worker
 *   STORAGE_BACKEND=s3 S3_BUCKET=rote AWS_ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 \
 *     DATABASE_URL=postgres://rote:rote@localhost:5433/rote npx tsx scripts/docker-cloud-check.ts
 */
const API = process.env.API_URL ?? 'http://localhost:8081';
const FIXTURE_URL = process.env.FIXTURE_URL ?? 'http://fixture:3100';

function lookupPlaybook(): PlaybookVersion {
  return {
    version: 1,
    engine_min_version: '1.0.0',
    playbook_type: 'extraction',
    output_format: { license_status: 'string', holder_name: 'string' },
    required_data_keys: ['license_number', 'last_name'],
    steps: [
      { op: 'goto', url: `${FIXTURE_URL}/lookup` },
      { op: 'fill', selector: '#licNum', value: '{{data.license_number}}' },
      { op: 'fill', selector: '#lastNm', value: '{{data.last_name}}' },
      { op: 'click', selector: '#submit' },
      { op: 'wait_for', selector: '.results-table' },
      { op: 'extract', schema_ref: 'output_format', scope_selector: '.results-table', fields: { license_status: '.status', holder_name: '.holder' } },
    ],
  };
}

interface Envelope {
  meta: { status: string; mode: string | null };
  result: Record<string, unknown> | null;
}

async function main(): Promise<void> {
  const env = loadEnvConfig(); // STORAGE_BACKEND=s3 + S3_BUCKET + AWS_ENDPOINT_URL + DATABASE_URL from the shell
  if (!env.s3Bucket) throw new Error('set STORAGE_BACKEND=s3 + S3_BUCKET');
  const db = createDb(env);
  const repo = new PlaybookRepository(db, new S3PlaybookStore(makeS3Client(env), env.s3Bucket));
  const id = newPlaybookId();
  await repo.create({ id, url: `${FIXTURE_URL}/lookup`, instruction: 'lookup a license', createdBy: 'manual', runId: null, body: lookupPlaybook() });
  await db.end();
  process.stdout.write(`seeded playbook ${id} to S3 + Postgres\n`);

  // POST to the API task → it persists (queued) + enqueues to SQS; the WORKER task executes.
  const sub = await fetch(`${API}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playbook_id: id, data: { license_number: 'CLOUD-1', last_name: 'Okonkwo' } }),
  });
  if (sub.status !== 202) throw new Error(`api POST ${sub.status}: ${await sub.text()}`);
  const runId = ((await sub.json()) as { meta: { run_id: string } }).meta.run_id;
  process.stdout.write(`api accepted run ${runId} (queued); waiting for the worker...\n`);

  const start = Date.now();
  for (;;) {
    const env2 = (await (await fetch(`${API}/v1/runs/${runId}`)).json()) as Envelope;
    if (['completed', 'completed_with_extraction_errors', 'failed'].includes(env2.meta.status)) {
      process.stdout.write(`  worker result: status=${env2.meta.status} mode=${env2.meta.mode} result=${JSON.stringify(env2.result)}\n`);
      const ok = env2.meta.status === 'completed' && env2.result?.holder_name === 'OKONKWO, CLOUD-1';
      if (!ok) {
        process.stdout.write('FAIL: cloud e2e did not complete with the expected result\n');
        process.exit(1);
      }
      process.stdout.write('CLOUD api→SQS→worker→S3 E2E: PASS\n');
      return;
    }
    if (Date.now() - start > 150_000) throw new Error(`timed out: ${JSON.stringify(env2.meta)}`); // cold worker's first browser launch is slow
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`cloud check failed: ${String(err)}\n`);
  process.exit(1);
});
