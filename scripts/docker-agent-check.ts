/**
 * Phase 4 in-Docker live agent gate: drive a real learn→replay against the DOCKERIZED engine over
 * HTTP — proving the agent path works inside the container (Chromium-in-image launch, egress to the
 * model API, key + base-URL handling), not just on the host. Requires the engine up with a funded
 * ANTHROPIC_API_KEY in its env (see docker-compose `engine.environment`). Run on the host:
 *   docker compose up --build -d
 *   AGENT_MODEL=anthropic/claude-sonnet-4-6 npx tsx scripts/docker-agent-check.ts
 */
const BASE = process.env.ENGINE_URL ?? 'http://localhost:8080';
const FIXTURE_URL = process.env.FIXTURE_URL ?? 'http://fixture:3100';
const MODEL = process.env.AGENT_MODEL ?? 'anthropic/claude-sonnet-4-6';

interface Envelope {
  meta: { status: string; mode: string | null; playbook_id: string | null; playbook_version: number | null; error?: { code: string } | null };
  result: Record<string, unknown> | null;
}

async function submit(payload: object): Promise<string> {
  const res = await fetch(`${BASE}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status !== 202) throw new Error(`submit ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { meta: { run_id: string } }).meta.run_id;
}

async function poll(runId: string, timeoutMs: number): Promise<Envelope> {
  const start = Date.now();
  for (;;) {
    const body = (await (await fetch(`${BASE}/v1/runs/${runId}`)).json()) as Envelope;
    if (['completed', 'completed_with_extraction_errors', 'failed'].includes(body.meta.status)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`run did not terminate: ${JSON.stringify(body.meta)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function main(): Promise<void> {
  process.stdout.write('LEARN (agent, in-container)...\n');
  const learn = await poll(
    await submit({
      instruction: 'Look up a license: type the license number and last name into the form and search.',
      url: `${FIXTURE_URL}/lookup`,
      data: { license_number: 'A123456', last_name: 'Nguyen' },
      output_format: { license_status: 'string', holder_name: 'string', expiry_date: 'string (ISO date)' },
      config: { model: MODEL },
    }),
    170_000,
  );
  process.stdout.write(`  learn: status=${learn.meta.status} playbook=${learn.meta.playbook_id} result=${JSON.stringify(learn.result)}\n`);
  if (learn.meta.status !== 'completed' || !learn.meta.playbook_id) {
    process.stdout.write(`FAIL: learn did not complete (error=${JSON.stringify(learn.meta.error)})\n`);
    process.exit(1);
  }

  process.stdout.write('REPLAY (deterministic, different data, no LLM)...\n');
  const replay = await poll(
    await submit({ playbook_id: learn.meta.playbook_id, data: { license_number: 'Z999000', last_name: 'Okonkwo' } }),
    60_000,
  );
  process.stdout.write(`  replay: status=${replay.meta.status} mode=${replay.meta.mode} result=${JSON.stringify(replay.result)}\n`);
  const ok =
    replay.meta.status === 'completed' &&
    replay.meta.mode === 'playbook' &&
    replay.result?.holder_name === 'OKONKWO, Z999000';
  if (!ok) {
    process.stdout.write('FAIL: replay did not return the new data deterministically\n');
    process.exit(1);
  }
  process.stdout.write('IN-DOCKER LIVE ROUND-TRIP: PASS\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`in-docker agent check failed: ${String(err)}\n`);
  process.exit(1);
});
