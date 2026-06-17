# Local Development

> Clone-to-running runbook. Goal: a new contributor (or you in three months) gets a working engine and runs a verification end-to-end without tribal knowledge. Firm up the exact commands as Phase 1 lands.

## 1. Prerequisites

- Node 24 (latest LTS; match the version pinned in `.nvmrc` / `package.json` engines).
- Docker + Docker Compose.
- A model-provider key/endpoint (only needed for agent-mode work — e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or a local `OLLAMA_BASE_URL`; replay/runner work needs none).

## 2. First run

```bash
git clone <repo> && cd <repo>
cp .env.example .env          # then fill in the values below
docker compose up --build     # engine + Postgres
```

`docker compose up` should bring both services healthy. Verify:

```bash
curl localhost:8080/v1/health   # → ok, db up, saturation zeros
```

Migrations run automatically on engine start (or via a documented `npm run migrate` — confirm at Phase 1).

## 3. Minimum `.env`

```env
SERVICE_MODE=all
PORT=8080
DATABASE_URL=postgres://rote:rote@postgres:5432/rote   # in-compose; host-run dev/tests use localhost:5433
STORAGE_BACKEND=local
STORAGE_LOCAL_PATH=/data
CACHE_BACKEND=local
# Model providers (env-only) — pick per-run via config.model="provider/name"; only for agent/heal/fallback
CONFIG_MODEL=                 # required for agent/heal/fallback runs, e.g. anthropic/claude-... or ollama/llama3.1
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
OLLAMA_BASE_URL=             # e.g. http://localhost:11434/v1 — local, no external call
SQS_ENABLED=false
MAX_CONCURRENT_RUNS=3
MAX_QUEUE_DEPTH=20
RUN_TIMEOUT_SECONDS=180
REPLAY_LLM_FALLBACK=off
```

Local mode uses the filesystem for playbooks/evidence/cache (`-v ./data:/data`) and a Postgres sidecar — no AWS needed. The full env surface is in `PROJECT_SPEC.md` §10 and `API_REFERENCE.md` §6.

## 4. Run something

**Replay an existing playbook (no LLM):**

```bash
curl -X POST localhost:8080/v1/runs -H 'content-type: application/json' -d '{
  "playbook_id": "pb_...",
  "data": { "license_number": "A123456", "last_name": "Nguyen" }
}'
# → 202 { meta: { run_id } } ; then GET /v1/runs/{run_id}
```

**Learn a new task (needs a model — set `CONFIG_MODEL` or `config.model`, plus the matching provider key):**

```bash
curl -X POST localhost:8080/v1/runs -H 'content-type: application/json' -d '{
  "instruction": "Look up the license and get its details",
  "url": "http://fixture-site:3000/lookup",
  "data": { "license_number": "A123456", "last_name": "Nguyen" },
  "config": { "model": "anthropic/claude-..." },
  "output_format": { "license_status": "string", "holder_name": "string" }
}'
```

Point `url` at the bundled fixture site for offline work, or a real Phase-0 test site.

## 5. The fixture site

`test/fixtures/site` is a local express app with a lookup→results flow, an action-only form, and a mutated variant (for heal tests), plus isolation endpoints (`/iso/set`→`/iso/apply`→`/iso/read`, which stamp a per-run token into the context's cookie + localStorage and read it back) and timing endpoints (`/slow?ms=`, `/hang`) used by the Phase 3 concurrency/isolation tests. Bring it up via the compose test profile (confirm the exact command at Phase 2). Integration tests run fully offline against it.

## 6. Tests

```bash
npm test                 # unit + integration (offline)
npx tsc --noEmit         # must be clean before every commit
npm run test:live        # opt-in: real agent runs vs fixture (needs API key)
```

Crank the release-blocking isolation test in CI via `ISO_CONCURRENCY` / `ISO_ROUNDS`
(`ISO_CONCURRENCY=24 ISO_ROUNDS=100 npx vitest run test/integration/concurrency.test.ts`).

**Phase 3 cold-start load + isolation gate** — drive the dockerized engine over real HTTP
(seeds an isolation playbook, fires sequential + concurrent replays, asserts zero
cross-contamination and that saturation returns to 0):

```bash
docker compose down -v && docker compose up --build -d
FIXTURE_URL=http://fixture:3100 DATABASE_URL=postgres://rote:rote@localhost:5433/rote \
  STORAGE_LOCAL_PATH=./data ENGINE_URL=http://localhost:8080 npx tsx scripts/phase3-load.ts
```

**Phase 4 in-Docker live agent gate** — a real learn→replay against the dockerized engine,
proving the agent path works *inside* the container (Chromium-in-image, model egress).
Needs a funded `ANTHROPIC_API_KEY` in `.env` (compose interpolates it into the engine; the
container also gets `CHROME_PATH` + `ALLOW_PRIVATE_TARGETS`):

```bash
docker compose up --build -d
npx tsx scripts/docker-agent-check.ts
```

**Phase 5 in-Docker self-heal + fallback gate** — a real mutate→heal→v2-replay and a surfaced
LLM fallback against the dockerized engine (same `ANTHROPIC_API_KEY` prereq):

```bash
docker compose up --build -d
FIXTURE_URL=http://fixture:3100 DATABASE_URL=postgres://rote:rote@localhost:5433/rote \
  STORAGE_LOCAL_PATH=./data npx tsx scripts/docker-heal-check.ts
```

## 7. Reading what happened

- **Logs:** structured JSON, `run_id`-scoped; `data` values are redacted.
- **Evidence:** `./data/evidence/{run_id}/` — `screenshot.png`, `page.html`.
- **Run record:** query Postgres `runs` by `run_id` for status/mode/error.
- **Playbook:** `./data/playbooks/{pb_id}/` — `meta.json` + `vN.json`.

## 8. Common failures

| Symptom | Likely cause |
|---|---|
| `/v1/health` db not up | Postgres not ready / wrong `DATABASE_URL` |
| `422` on a replay | missing `required_data_keys` for that playbook (check `GET /v1/playbooks/{id}`) |
| agent run errors with no model | `model` unset (no `config.model`/`CONFIG_MODEL`) or the matching provider key unset |
| `captcha_detected` | the target site is bot-walled — pick a different test site |
| `429` on submit | `MAX_QUEUE_DEPTH` reached — expected under burst; raise limits or back off |
| OOM under load | `MAX_CONCURRENT_RUNS` too high for the box (~2GB/run) |

## 9. Modes (later phases)

`SERVICE_MODE=all` is the local default (HTTP + in-process workers). `api` + `worker` (SQS-fed, S3-backed) is the production split introduced in Phase 6 — see `ARCHITECTURE.md` §8.3.
