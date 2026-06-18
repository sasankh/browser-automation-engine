# Operator Guide

Running Rote in production. (Authoritative config source: [PROJECT_SPEC.md](../PROJECT_SPEC.md) §10,
[ARCHITECTURE.md](../ARCHITECTURE.md) §8. Local dev: [LOCAL_DEV.md](../LOCAL_DEV.md).)

## Topologies (`SERVICE_MODE`)

| Mode | Role | Browser? | Scale on |
|---|---|---|---|
| `all` | HTTP + in-process job loop + browser (one box) | yes | request rate |
| `api` | HTTP: validate / persist / **enqueue** to SQS (no execution) | no | request rate |
| `worker` | **consume** SQS + execute (+ `/health`, `/metrics`) | yes | **queue depth** (`ApproximateNumberOfMessages`) |

`api` requires `SQS_ENABLED=true` + `SQS_QUEUE_URL` (it errors at boot otherwise). One orchestrator
serves HTTP and SQS — the payload→envelope contract is identical across both. Run the scaled topology
with `docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d postgres localstack fixture api worker`
(swap LocalStack for real AWS by unsetting `AWS_ENDPOINT_URL`).

## Config precedence

Every behavior knob resolves **`payload.config` > env > built-in default**. **Destinations** (storage,
SQS, webhooks, secrets) and **capacity ceilings** (`MAX_CONCURRENT_RUNS`, `MAX_QUEUE_DEPTH`,
`BROWSER_RECYCLE_RUNS`, `MAX_RUN_TIMEOUT_SECONDS`) are **env-only** — a payload can change behavior, never
destinations or ceilings. See `.env.example` for the full surface.

## Env reference (selected)

| Var | Default | Notes |
|---|---|---|
| `SERVICE_MODE` | `all` | `all` / `api` / `worker` |
| `DATABASE_URL` | — (required) | Postgres (RDS in cloud) |
| `STORAGE_BACKEND` | `local` | `local` / `s3`; `s3` needs `S3_BUCKET` (+ `AWS_REGION`, optional `AWS_ENDPOINT_URL`) |
| `MAX_CONCURRENT_RUNS` | `3` | browser semaphore — size to `~2 GB` RAM/run |
| `MAX_QUEUE_DEPTH` | `20` | in-process waiting room (`all`); overflow → `429`. SQS is the buffer in `api`/`worker` |
| `RUN_TIMEOUT_SECONDS` / `MAX_RUN_TIMEOUT_SECONDS` | `180` / `600` | per-run wall clock + the ceiling a payload can request |
| `BROWSER_RECYCLE_RUNS` | `10` | recycle the Chromium process after N runs (memory hygiene) |
| `SHUTDOWN_GRACE_SECONDS` | `25` | drain window on SIGTERM before forced exit |
| `SQS_ENABLED` / `SQS_QUEUE_URL` / `SQS_RESULTS_QUEUE_URL` | `false` / — / — | run queue + optional results fan-out |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `300` | must exceed `RUN_TIMEOUT_SECONDS`; the consumer heartbeats to extend |
| `WEBHOOK_MAX_RETRIES` | `3` | `callback_url` delivery retries (unsigned) |
| `CONFIG_MODEL` | — | fallback `model` for agent/heal/fallback when the payload omits it (`provider/name`) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / … | — | provider keys — **env/secret-manager only** |
| `REPLAY_LLM_FALLBACK` / `REPLAY_LLM_FALLBACK_MODEL` | `off` / — | surfaced one-shot LLM extraction rescue |
| `HEAL_FAILURE_THRESHOLD` | `3` | consecutive heal failures → playbook `health=unhealthy` |
| `ALLOW_PRIVATE_TARGETS` / `ALLOWED_PRIVATE_CIDRS` | `false` / — | SSRF: permit all private hosts (dev), or allowlist internal CIDRs (prod) |
| `STORE_RUN_INPUTS` | `false` | off → run rows store data **keys**, not values |

## Capacity & scaling

- **Memory:** budget ~**2 GB per concurrent run** (Chromium + page). The engine warns at boot if
  `MAX_CONCURRENT_RUNS × 2 GB` exceeds detectable container memory. Size `MAX_CONCURRENT_RUNS` to RAM.
- **Workers:** autoscale on SQS backlog (`ApproximateNumberOfMessages` / desired-backlog-per-task). Each
  worker runs its own small `MAX_CONCURRENT_RUNS`; the consumer prefetches only up to free slots.
- **API tasks:** cheap and stateless (no browser) — scale on request rate.
- **Backpressure:** `all` mode returns `429` + `Retry-After` when `MAX_CONCURRENT_RUNS + MAX_QUEUE_DEPTH`
  is full. In `api`/`worker`, SQS absorbs bursts.
- **Graceful deploys:** SIGTERM stops intake (consumer + queue), lets in-flight runs finish within
  `SHUTDOWN_GRACE_SECONDS`, then exits — Fargate rollouts don't sever live browser sessions.

## Health & metrics

- **`GET /v1/health`** → `200 { status, db, runs_in_progress, queue_depth, max_concurrent_runs }`
  (`503 degraded` if Postgres is unreachable, `draining` during shutdown). Use as the load-balancer /
  ECS health check.
- **`GET /metrics`** (Prometheus, unauthenticated — scrape on the private network):
  `runs_total{mode,status}`, `heal_total{outcome}`, `fallback_engaged_total{playbook_id}`,
  `agent_tokens_total{kind}`, `run_duration_seconds{mode}` (histogram), `webhook_delivery_total{status}`,
  `requests_rejected_total{reason}`, `playbook_hit_ratio`, and saturation gauges `runs_in_progress` /
  `queue_depth` / `max_concurrent_runs`, plus default process metrics. A dashboard can chart heal rate,
  fallback rate, saturation, and token spend directly from these.
- **Playbook drift:** `GET /v1/playbooks?health=unhealthy` surfaces playbooks with repeated heal
  failures (or, with `FALLBACK_AS_DRIFT_SIGNAL=on`, repeated fallback engagements → `needs_relearn`).

## Storage & retention

- **Postgres** is the authoritative index (runs, playbook index, idempotency). Migrations apply
  automatically on start (advisory-locked, safe across replicas).
- **Playbook bodies + evidence** are blobs in local FS or S3 (`STORAGE_BACKEND`). Evidence is
  `evidence/{run_id}/` (`screenshot.png`, `page.html`). **Retention is the operator's job** — set an S3
  lifecycle rule (e.g. expire evidence after N days); the engine doesn't auto-prune.
- **Secrets** (provider keys, DB creds, webhook secrets, proxy creds) are env / secret-manager only and
  never appear in payloads, logs, or playbook bodies.
