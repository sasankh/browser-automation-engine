# Rote — Universal Instruction-Driven Browser Automation Engine

A self-hosted, Dockerized service that performs browser tasks on **any** website from natural-language
instructions. Its defining idea is **two-speed execution**: the first run of a task uses an AI agent to
figure it out and **compiles the result into a versioned, parameterized "playbook"**; every later run
**replays that playbook with plain Playwright — no LLM, near-zero cost**. When a playbook breaks (site
redesign), the agent **self-heals** it into a new version. The engine is domain-agnostic — callers
supply the task, target, inputs, and the output shape.

> Learn once (expensive, ~seconds of model time). Replay forever (deterministic, ~free).

- **What & contract:** [PROJECT_SPEC.md](PROJECT_SPEC.md) · **How & layering:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Caller integration:** [docs/CALLER_GUIDE.md](docs/CALLER_GUIDE.md) · **Operations:** [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md)
- **Local dev:** [LOCAL_DEV.md](LOCAL_DEV.md) · **Security posture:** [SECURITY_REVIEW.md](SECURITY_REVIEW.md)

## Quickstart (local, single container)

```bash
cp .env.example .env            # set ANTHROPIC_API_KEY if you want agent/learn runs (replay needs no key)
docker compose up --build       # engine + Postgres (SERVICE_MODE=all, local-FS storage) on :8080
curl localhost:8080/v1/health   # liveness + live saturation
```

**Replay a known playbook** (deterministic, no model):

```bash
curl -sX POST localhost:8080/v1/runs -H 'content-type: application/json' -d '{
  "playbook_id": "pb_...",
  "data": { "license_number": "A123456", "last_name": "Nguyen" }
}'
# → 202 { "meta": { "run_id": "run_...", "status": "queued" } }
curl localhost:8080/v1/runs/run_...   # poll until status is terminal
```

**Learn a new task** (agent, needs a model — `config.model` is required, no default):

```bash
curl -sX POST localhost:8080/v1/runs -H 'content-type: application/json' -d '{
  "instruction": "Look up a license: type the license number and last name into the form and search.",
  "url": "https://example.gov/lookup",
  "data": { "license_number": "A123456", "last_name": "Nguyen" },
  "output_format": { "license_status": "string", "holder_name": "string" },
  "config": { "model": "anthropic/claude-sonnet-4-6" }
}'
# → learns it, compiles a playbook, returns meta.playbook_id + version 1. Replay it cheaply thereafter.
```

Runs are **async**: `POST` returns `202` with a `run_id`; poll `GET /v1/runs/:id` (or supply a
`callback_url` for a webhook). Full payload + envelope reference: [docs/CALLER_GUIDE.md](docs/CALLER_GUIDE.md).

## How it works (one paragraph)

A fresh `instruction`+`url` runs in **agent mode** (Stagehand v3.5 driving a configured model provider —
Anthropic / OpenAI / Google / local). As the agent acts, the engine records each effective step and
links typed values back to their `data` keys **by value identity**, then **compiles** a declarative
playbook (`goto`/`fill`/`click`/`extract`/… — a fixed op vocabulary, never `eval`'d). Replays bind the
caller's `data` into `{{data.*}}` slots and interpret the ops with plain Playwright. A structural
extraction miss can fall back to a **surfaced** one-shot LLM extract; a runner failure can **self-heal**
into a new version. Mechanism walk-through: [ARCHITECTURE.md](ARCHITECTURE.md) §4.

## Deployment shapes

- **`all`** — one container: HTTP + an in-process job loop + browser. Laptops / small boxes.
- **`api` + `worker`** — the same image split by `SERVICE_MODE`: cheap stateless `api` tasks
  (validate/persist/enqueue) feed **SQS**; heavy `worker` tasks (browser) consume and execute. Postgres
  (RDS), S3 (playbooks/evidence/cache). Scale workers on queue depth. See
  [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md) and `docker-compose.cloud.yml`.

## Security posture (v1)

The engine is designed to run **behind a trusted gateway** that terminates caller auth (API auth, keys,
and webhook signing are the gateway's job — `API_AUTH_MODE=none`). What the engine owns itself:
**SSRF protection** (private/loopback/link-local/metadata egress blocked for the initial url, replay
`goto`s, and agent navigation — opt in to internal targets via `ALLOWED_PRIVATE_CIDRS`), **data no-leak**
(values redacted in logs; run rows store keys not values; playbook bodies hold only `{{data.*}}`), and
**no code execution from learned artifacts** (a fixed op vocabulary, never `eval`'d). Details +
adversarial review: [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

## Commands

```bash
npm test            # unit + integration, offline against the bundled fixture site (needs Postgres + LocalStack)
npx tsc --noEmit    # typecheck (must be clean before every commit)
npm run test:live   # opt-in: real agent runs vs the fixture (needs ANTHROPIC_API_KEY)
npm run migrate     # Postgres migrations (also run automatically on engine start)
```

Observability: structured JSON logs (`run_id`-scoped, redacted) and Prometheus `/metrics`
(`runs_total`, `heal_total`, `fallback_engaged_total`, `agent_tokens_total`, `run_duration_seconds`,
saturation gauges, …).
