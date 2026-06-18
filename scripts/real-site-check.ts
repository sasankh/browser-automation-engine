import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaybookRunner } from '../src/execution/playbook/runner';
import { LocalEvidenceStore } from '../src/persistence/evidence/evidence.local';
import { BrowserPool } from '../src/browser/pool';
import type { PlaybookVersion } from '../src/execution/playbook/playbook-schema';

/**
 * Phase 2 gate: hand-author a playbook for a REAL external site and run it, to validate the op
 * vocabulary against real-world HTML (not just the fixture). Default target is the public, stable
 * quotes.toscrape.com; override with SITE_URL. Runs the deterministic runner directly (no DB).
 */
async function main(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'rote-realsite-'));
  const runner = new PlaybookRunner(new LocalEvidenceStore(tmp));
  const pool = new BrowserPool(10);
  const url = process.env.SITE_URL ?? 'https://quotes.toscrape.com/';

  const body: PlaybookVersion = {
    version: 1,
    engine_min_version: '1.0.0',
    playbook_type: 'extraction',
    output_format: { quote: 'string', author: 'string', tag: 'string' },
    required_data_keys: [],
    steps: [
      { op: 'goto', url },
      { op: 'wait_for', selector: '.quote' },
      {
        op: 'extract',
        schema_ref: 'output_format',
        scope_selector: '.quote',
        fields: { quote: '.text', author: '.author', tag: '.tags .tag' },
      },
    ],
    assertions: [{ after_step: 1, expect: 'selector_present', selector: '.quote .author' }],
  };

  const ctx = await pool.acquire(true);
  try {
    const outcome = await runner.run({
      runId: 'real-site-check',
      page: ctx.page,
      playbook: body,
      data: {},
      defaultTimeoutMs: 20_000,
      captureEvidence: true,
    });
    console.log(
      JSON.stringify(
        { url, status: outcome.status, result: outcome.result, extractionErrors: outcome.extractionErrors, evidenceDir: tmp },
        null,
        2,
      ),
    );
  } finally {
    await ctx.release();
    await pool.shutdown();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
