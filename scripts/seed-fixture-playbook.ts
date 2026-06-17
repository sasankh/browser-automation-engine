import { loadEnvConfig } from '../src/shared/env';
import { createDb } from '../src/persistence/db';
import { LocalPlaybookStore } from '../src/persistence/playbooks/store.local';
import { PlaybookRepository } from '../src/persistence/playbooks/repository';
import { newPlaybookId } from '../src/shared/ids';
import type { PlaybookVersion } from '../src/execution/playbook/playbook-schema';

/**
 * Seed a hand-authored extraction playbook for the dockerized cold-start gate. Writes to the shared
 * data volume + Postgres index; the engine container then replays it. Run on the host:
 *   FIXTURE_URL=http://fixture:3100 DATABASE_URL=postgres://rote:rote@localhost:5433/rote \
 *   STORAGE_LOCAL_PATH=./data npx tsx scripts/seed-fixture-playbook.ts
 */
async function main(): Promise<void> {
  const env = loadEnvConfig();
  const db = createDb(env);
  const store = new LocalPlaybookStore(env.storageLocalPath);
  const repo = new PlaybookRepository(db, store);

  const fixtureUrl = process.env.FIXTURE_URL ?? 'http://fixture:3100';
  const id = process.env.SEED_PB_ID ?? newPlaybookId();

  const body: PlaybookVersion = {
    version: 1,
    engine_min_version: '1.0.0',
    playbook_type: 'extraction',
    output_format: { license_status: 'string', holder_name: 'string', expiry_date: 'string (ISO date)' },
    required_data_keys: ['license_number', 'last_name'],
    steps: [
      { op: 'goto', url: `${fixtureUrl}/lookup` },
      { op: 'fill', selector: '#licNum', value: '{{data.license_number}}' },
      { op: 'fill', selector: '#lastNm', value: '{{data.last_name}}' },
      { op: 'click', selector: '#submit' },
      { op: 'wait_for', selector: '.results-table' },
      {
        op: 'extract',
        schema_ref: 'output_format',
        scope_selector: '.results-table',
        fields: { license_status: '.status', holder_name: '.holder', expiry_date: '.expiry' },
      },
    ],
    assertions: [{ after_step: 4, expect: 'url_matches', pattern: 'results' }],
  };

  await repo.create({
    id,
    url: `${fixtureUrl}/lookup`,
    instruction: 'look up a license',
    createdBy: 'manual',
    runId: null,
    body,
  });
  await db.end();
  process.stdout.write(`${id}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`seed failed: ${String(err)}\n`);
  process.exit(1);
});
