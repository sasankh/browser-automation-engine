# PROJECT_SPEC: Universal Instruction-Driven Browser Automation Engine

> Working name: **engine** (final name TBD — see Open Questions)
> Status: Draft v1 — for review before implementation
> Format: This spec is written to be executed incrementally with Claude Code. Phases are at the end.

---

## 1. Overview

A self-hosted, Dockerized service that performs browser-based tasks on any website, driven by natural-language instructions. The first time a task runs, an AI agent (Stagehand driving a configured LLM provider — Anthropic, OpenAI, Google, or a local model) figures out how to perform it. The successful run is **compiled into a versioned, parameterized playbook**. Every subsequent run replays the playbook deterministically with plain Playwright — no LLM, near-zero cost. When a playbook breaks (site redesign), the agent **self-heals** it by re-exploring and writing a new playbook version.

The engine is **universal**: it knows nothing about license verification, KYB, or any domain. Callers define the task (instruction), the target (url), the inputs (data), and the desired output shape (output_format). Domain systems are pure consumers.

```
                 ┌─────────────────────────────────────────────┐
                 │              ENGINE (Docker)                │
  HTTP POST ──►  │  ┌─────────┐   ┌──────────────────────┐     │
                 │  │  API     │──►│  Run Orchestrator    │     │
  SQS msg  ──►  │  │ / SQS    │   │  (resolution logic)  │     │
  (if enabled)   │  └─────────┘   └──────┬───────────────┘     │
                 │                       │                      │
                 │        ┌──────────────┼──────────────┐       │
                 │        ▼              ▼               │      │
                 │  ┌───────────┐  ┌────────────┐        │      │
                 │  │ Playbook  │  │ Agent      │        │      │
                 │  │ Runner    │  │ Engine     │──► LLM provider │
                 │  │ (no LLM)  │  │ (Stagehand)│        │      │
                 │  └─────┬─────┘  └─────┬──────┘        │      │
                 │        │              │ compiles      │      │
                 │        ▼              ▼               │      │
                 │  ┌──────────────────────────┐         │      │
                 │  │ Playwright + Chromium    │         │      │
                 │  └──────────────────────────┘         │      │
                 │                                       │      │
                 │  Playbook Store (local | S3, versioned)      │
                 │  Selector Cache (local | S3)                 │
                 │  Evidence Store (local | S3)                 │
                 │  Run Records (PostgreSQL)                    │
                 └─────────────────────────────────────────────┘
                       │ webhook (meta + result envelope)
                       ▼
                  Caller systems
```

## 2. Goals

- **Universal**: any website, any task; zero domain logic in the engine.
- **Learn once, replay free**: agent runs are expensive (LLM tokens, slow); playbook replays are cheap and fast. The system should converge to >95% playbook-mode runs in steady state.
- **Self-healing**: site changes cost exactly one agent run, automatically.
- **Deployable anywhere**: single Docker image; runs on a laptop with local storage, or on ECS with S3 + SQS, switched purely by config.
- **Auditable**: every run produces evidence (screenshot + HTML) and full lineage (which playbook version, why it exists, what config was in effect).
- **Honest failure**: the engine never returns fabricated data. Extraction is schema-validated; anything that can't be confidently extracted is reported as missing, not guessed.

### Non-goals (v1)

- CAPTCHA solving or anti-bot evasion (runs that hit a CAPTCHA fail with a distinct error code).
- Authenticated sessions / login flows (see Open Questions — likely v2).
- Multi-page paginated scraping / "for each row" iteration (list-valued data is a v2 design discussion).
- Scheduling/cron (callers own scheduling; the engine is request-driven).
- Multi-tenancy and per-tenant rate limiting (single-trust-domain v1; see Open Questions).

## 3. Terminology

| Term | Meaning |
|---|---|
| **Run** | One execution of a task (agent mode or playbook mode). Has a `run_id`. |
| **Instruction** | Natural-language description of the task, supplied by the caller. |
| **Playbook** | Compiled, parameterized, deterministic recipe for a task. Has a `playbook_id` and versions. |
| **Agent mode** | Stagehand + a configured LLM provider (Anthropic, OpenAI, Google, or local) working from an instruction. Produces a playbook on success. |
| **Playbook mode** | Plain Playwright executing stored steps. No LLM. |
| **Self-heal** | Automatic fallback from a failed playbook run to agent mode, producing a new playbook version. |
| **Evidence** | Screenshot + final HTML captured at the end of a run. |
| **Envelope** | The universal response object: `{ meta, result }`. |

## 4. Invocation Interfaces

Two transports, one payload schema, one response envelope. The SQS consumer and the HTTP handler share the same validation and orchestration code.

### 4.1 HTTP API

```
POST   /v1/runs                       submit a run            → 202 + { meta: { run_id, status: "queued" } }
GET    /v1/runs/{run_id}              poll status / result    → envelope
GET    /v1/runs/{run_id}/evidence     signed/streamed evidence
GET    /v1/playbooks                  list playbooks
GET    /v1/playbooks/{id}             playbook contract: required data keys, output_format, versions, active_version
GET    /v1/playbooks/{id}/versions/{v} specific version detail
POST   /v1/playbooks/{id}/activate    move active_version pointer { "version": n }   (rollback)
DELETE /v1/playbooks/{id}             soft-delete (tombstone; versions retained on disk)
GET    /v1/health                     liveness/readiness
```

- `POST /v1/runs` is always async: validate, persist run record, enqueue, return `202`.
- Results are delivered by webhook (`callback_url` in payload) and/or polled via `GET /v1/runs/{run_id}`.
- (Open Question: optional synchronous mode `?wait=true` with a timeout, for short playbook runs.)

### 4.2 SQS (enabled by config)

- `SQS_ENABLED=true` starts a consumer loop alongside (or instead of) the HTTP server, per `SERVICE_MODE`.
- Message body = exactly the same JSON payload as `POST /v1/runs`.
- Visibility timeout must exceed `run_timeout_seconds`; the consumer extends heartbeat for long agent runs.
- Failed messages (validation errors, repeated crashes) go to a DLQ (the SQS queue's redrive policy).
- Results: webhook if `callback_url` present; optionally publish the envelope to `SQS_RESULTS_QUEUE_URL` if configured.

## 5. Request Payload

Identical for HTTP and SQS.

```jsonc
{
  // Task definition (first run / self-heal source)
  "instruction": "string — natural-language task description",   // required if no playbook_id
  "url": "https://target.site/path",                              // required with instruction
  "output_format": { /* desired result shape — see 5.2 */ },      // optional; absent = action-only task

  // Replay
  "playbook_id": "pb_...",          // optional; if present, playbook mode
  "playbook_version": 3,            // optional; pin a specific version (default: active_version)

  // Inputs
  "data": { /* flat JSON object of named values used on the page */ },

  // Per-run config overrides (see §10)
  "config": { "playbook_self_heal": true },

  // Delivery
  "callback_url": "https://caller/hooks/results",   // optional
  "idempotency_key": "caller-scoped-unique-string"  // optional, strongly recommended
}
```

### 5.1 `data`

- Flat JSON object. Keys are caller-chosen, **self-describing names** (`license_number`, `last_name`, `order_id`); the agent uses key names to decide which page fields receive which values.
- Values: strings/numbers/booleans in v1. Lists and nested objects are v2 (Open Question).
- On playbook replay, `data` is validated against the playbook's recorded `required_data_keys` **before** a browser launches. Missing keys → `422`, no run.
- `data` values are treated as **sensitive by default**: logged redacted, never included in compiled playbooks (only `{{data.key}}` references are stored).

### 5.2 `output_format`

- A JSON object describing the desired shape of `result`. Keys are field names; values are type hints (`"string"`, `"number"`, `"boolean"`, `"array of strings"`, `"string (ISO date)"`, nested objects allowed).
- Internally converted to a Zod schema driving Stagehand `extract()` — extraction is validated, not freeform.
- Saved into the playbook **per version**. Replays use the saved format; the payload never needs to resend it.
- Absent on first run → **action-only playbook** (`playbook_type: "action"`); runs perform the process and return `result: null`.
- `output_format` + `playbook_id` together → creates a new playbook version with the updated extraction step (navigation steps reused; agent re-invoked only if the new fields can't be located from the stored page state).

### 5.3 Resolution logic (normative)

```
1. playbook_id present?
   → load playbook (pinned version or active_version)
   → validate data against required_data_keys
   → PLAYBOOK MODE
   → on failure: if resolved config playbook_self_heal == true
        → AGENT MODE using payload.instruction, else playbook.meta.instruction
        → on success: write v(n+1), move active pointer, complete the run
        → on failure: run fails (error.heal_attempted = true)

2. else instruction present?
   → AGENT MODE against url with data (+ output_format if present)
   → on success: compile playbook, assign playbook_id, save v1, return id in meta

3. else → 422 validation error (nothing to do)
```

## 6. Response Envelope

Every result — HTTP poll, webhook body, results queue message — is the same object:

```jsonc
{
  "meta": {
    "run_id": "run_01JA9F...",
    "status": "completed",                  // see §7
    "mode": "playbook",                     // "playbook" | "agent"
    "playbook_id": "pb_01J9XK...",
    "playbook_version": 3,
    "playbook_type": "extraction",          // "extraction" | "action"
    "self_healed": false,                    // true → playbook_version is the NEW version
    "duration_ms": 41250,
    "started_at": "2026-06-10T15:02:11Z",
    "finished_at": "2026-06-10T15:02:52Z",
    "evidence": { "screenshot_url": "...", "html_url": "..." },
    "effective_config": { /* fully resolved config for this run */ },
    "error": null,                           // populated on failed runs — see §7
    "extraction_errors": null,               // populated on partial extraction — see §7
    "webhook_status": null                   // "delivered" | "failed" | null — callback_url delivery (Phase 6)
  },
  "result": { /* exactly the caller's output_format shape */ }   // or null
}
```

Envelope invariants:

- `result` is **only ever** the caller-defined shape, or `null`. The engine never injects fields into it.
- All system information lives in `meta`. New meta fields may be added over time (additive, non-breaking).
- Webhooks are delivered to `callback_url` and retried with backoff (`WEBHOOK_MAX_RETRIES`, default 3) on non-2xx; the outcome is recorded in `meta.webhook_status`. **They are unsigned** — the engine runs behind a trusted gateway that owns caller auth and webhook verification, so an HMAC `X-Engine-Signature` is reserved, not emitted (DECISIONS #30/#32).

## 7. Statuses & Error Model

`meta.status` values:

| Status | Terminal | Meaning |
|---|---|---|
| `queued` | no | Accepted, awaiting a worker. |
| `running` | no | Browser session in progress. |
| `completed` | yes | Process done; if extraction playbook, `result` fully satisfies the format. |
| `completed_with_extraction_errors` | yes | Process done; some fields missing → `null` in `result`, details in `meta.extraction_errors`. |
| `failed` | yes | Process did not complete. `result: null`, `meta.error` populated. |

`meta.error` shape:

```json
{
  "code": "step_failed",
  "step": 4,
  "message": "selector #licNum not found",
  "heal_attempted": true,
  "heal_outcome": "agent_could_not_locate_lookup_form"
}
```

Error codes (initial set): `validation_error`, `step_failed`, `navigation_failed`, `timeout`, `captcha_detected`, `extraction_failed`, `agent_gave_up`, `browser_crashed`, `playbook_not_found`, `internal_error`.

`meta.extraction_errors` shape (per failed field):

```json
[ { "field": "expiry_date", "reason": "not_found_on_page" } ]
```

Self-heal eligibility is defined for **every** error code (the Phase 5 builder confirms this list):

| Error code | Heal policy |
|---|---|
| `step_failed` | Heals (a broken selector is the canonical redesign signal). |
| `navigation_failed` | Heals (page/URL structure may have moved). |
| `extraction_failed` | Heals only if `self_heal_on_extraction_failure=true` (fields may have moved after a redesign). |
| `captcha_detected` | Never heals (re-running the agent won't pass a CAPTCHA). |
| `timeout` | Never heals (a re-run would likely time out again; surfaces a real problem). |
| `validation_error` | Never heals (caller input problem, not a site problem). |
| `playbook_not_found` | Never heals (nothing to heal; caller error). |
| `agent_gave_up` | Never heals (the agent already tried and failed; auto-retry would just burn tokens). |
| `browser_crashed` | Never heals automatically; eligible for **infrastructure retry** (re-run the same mode once) rather than agent re-exploration. |
| `internal_error` | Never heals; surfaced for investigation. |

In all cases heal also requires resolved `playbook_self_heal=true`; a heal that itself fails sets `error.heal_attempted=true` with `heal_outcome`.

## 8. Playbook Specification

### 8.1 Identity & layout

Identical layout on local disk and S3 (prefix = bucket key prefix):

```
playbooks/
  pb_01J9XK/
    meta.json
    v1.json
    v2.json
    v3.json
```

`meta.json`:

```jsonc
{
  "playbook_id": "pb_01J9XK...",
  "created_at": "2026-06-01T...",
  "active_version": 3,
  "playbook_type": "extraction",
  "instruction": "original instruction text (used for self-heal)",
  "url": "https://...",
  "required_data_keys": ["license_number", "last_name"],
  "deleted": false,
  "versions": [
    { "version": 1, "created_at": "...", "created_by": "agent_initial", "run_id": "run_..." },
    { "version": 2, "created_at": "...", "created_by": "self_heal",     "run_id": "run_..." },
    { "version": 3, "created_at": "...", "created_by": "self_heal",     "run_id": "run_..." }
  ]
}
```

### 8.2 Version file (`vN.json`) — declarative steps

Playbooks are **declarative JSON interpreted by the runner**, not generated code. (Rationale: safe to store/transfer, diffable across versions, no eval of LLM-generated code, trivially parameterized. Trade-off: a step vocabulary to maintain.)

```jsonc
{
  "version": 3,
  "engine_min_version": "1.0.0",
  "output_format": { /* saved caller format, or null for action type */ },
  "required_data_keys": ["license_number", "last_name"],
  "steps": [
    { "op": "goto",    "url": "https://www.mbc.ca.gov/license-lookup/" },
    { "op": "click",   "selector": "a[href*='lookup']", "description": "open lookup form",
      "fallback_selectors": ["text=License Lookup"] },
    { "op": "fill",    "selector": "#licNum",  "value": "{{data.license_number}}" },
    { "op": "fill",    "selector": "#lastNm",  "value": "{{data.last_name}}" },
    { "op": "click",   "selector": "button[type=submit]" },
    { "op": "wait_for","selector": ".results-table", "timeout_ms": 15000 },
    { "op": "extract", "schema_ref": "output_format", "scope_selector": ".results-table",
      "fields": { "license_status": ".status", "holder_name": ".holder" } }
  ],
  "assertions": [
    { "after_step": 5, "expect": "url_matches", "pattern": "results" }
  ]
}
```

Step vocabulary v1: `goto`, `click`, `fill`, `select`, `check`, `press`, `wait_for`, `wait_ms`, `scroll`, `extract`, `screenshot`. Each step records `description` (agent's intent) and optional `fallback_selectors` (alternates Stagehand observed) — fallbacks are tried before declaring `step_failed`, which absorbs minor DOM churn without a heal.

### 8.3 Parameterization

- During compilation, every value the agent entered that came from `data` is replaced by `{{data.<key>}}`. Literal values typed by the agent that did NOT come from `data` are stored literally (they're part of the process, e.g., selecting "Physician" in a category dropdown).
- Matching is by exact value provenance (the orchestrator tracks which data values were handed to which `act()` calls), not string search — avoids accidental templating when a data value coincides with page text.
- `extract` steps carry no data; they bind to the version's `output_format`.

### 8.4 Versioning rules

- Append-only. A new version is created by: self-heal, an `output_format` change against an existing `playbook_id`, or an explicit re-learn request (payload with both `playbook_id` and `instruction` + config flag `force_relearn: true`).
- `active_version` pointer moves automatically on successful heal/relearn. Rollback = `POST /v1/playbooks/{id}/activate`.
- Pinned replays (`playbook_version` in payload) never move the pointer and never self-heal into the pinned slot (a heal from a pinned run still writes v(n+1)).

## 9. Execution Engine

### 9.1 Agent mode (Stagehand)

1. Resolve config (including the **required** `model` as `provider/name` — absent → `validation_error`); launch browser (Playwright, `channel` per config, proxy if `proxy_enabled`).
2. Construct agent context: instruction, url, data (keys + values), output_format if present.
3. `stagehand.agent()` drives navigation/actions; orchestrator records every `act()`/`observe()` with selectors and data-value provenance.
4. If extraction task: `extract()` with Zod schema from output_format; validate.
5. Capture evidence (screenshot + HTML).
6. Compile recorded actions → declarative steps (§8.2), parameterize (§8.3), save version, update meta.json.
7. Persist run record; emit envelope (webhook / poll / results queue).

Guardrails: hard step budget (`agent_max_steps`, default 25), wall-clock timeout, domain allowlist confinement (agent may not navigate off the target site's registrable domain unless `allow_offsite: true` in config), and `captcha_detected` short-circuit (heuristics: known CAPTCHA iframes/selectors).

### 9.2 Playbook mode (runner)

1. Load version file; validate `data` against `required_data_keys`.
2. Launch plain Playwright (no Stagehand, no LLM).
3. Interpret steps; per step: try primary selector → fallbacks → fail with `step_failed` + step index.
4. `extract` op: deterministic DOM extraction using stored scope + field selectors. Fields that can't be located are extraction errors (never guessed). If `REPLAY_LLM_FALLBACK=on` and ≥1 field is missing, the runner invokes a one-shot LLM extraction (`REPLAY_LLM_FALLBACK_MODEL`) for the missing fields only. **Engagement is always surfaced**: `meta.llm_fallback_used = true` plus `meta.fallback_fields` listing which fields the LLM resolved, and the event is counted per-playbook (`fallback_engaged_total`) so quiet drift toward obsolescence is visible. A run that needed the fallback is still `completed` (the data is correct), but a playbook can be flagged for proactive re-learn after K engagements if `FALLBACK_AS_DRIFT_SIGNAL=on`. With `REPLAY_LLM_FALLBACK=off` (default), missing fields → `completed_with_extraction_errors`, no LLM.
5. Evidence, validate, envelope. Target p50 latency: < 30s (structural path; fallback adds one model round-trip).

### 9.3 Self-heal

1. Playbook run fails with a heal-eligible code (§7) and resolved `playbook_self_heal` is true.
2. Same run continues in agent mode (same `run_id`, `meta.mode` becomes `agent`, `meta.self_healed: true`). Instruction source: payload instruction if present, else `meta.json` stored instruction.
3. Success → compile v(n+1), move pointer, return envelope with new `playbook_version`.
4. Failure → `failed` envelope with `heal_attempted: true` and both failure reasons.

### 9.4 Concurrency & request isolation

The engine serves many requests simultaneously in production. Two things must hold: requests stay fully isolated (correctness), and the number running at once is bounded (resource safety). Full mechanism is in `ARCHITECTURE.md` §8; the normative summary:

**Isolation invariants (hold at any concurrency level):**
- **One `BrowserContext` per run**, created at start, closed at end — its own cookies/storage/cache, so no run's session or form state can leak into another. The Chromium *process* may be shared across contexts; the *context* and `Page` and Stagehand instance never are. Reusing pages/contexts across runs is forbidden.
- **No shared mutable state**: each run threads its own context object (`run_id`, bound `data`, resolved config, recorder, evidence paths); nothing about a run lives in module-level/global scope.
- **Per-run data binding**: `{{data.*}}` resolves against this run's data only; the provenance index is built and discarded per run.
- **Keyed writes**: `evidence/{run_id}/`, `(playbook_id, version)` — never shared paths.
- **Postgres**: pooled connections; the `active_version` move is a single transaction; idempotency keys are unique-constrained.

**Capacity limits (three distinct, per-container, env-only):**

| Limit | Env var | Default | Governs |
|---|---|---|---|
| Concurrent runs | `MAX_CONCURRENT_RUNS` | `3` | runs holding a browser context at once (the resource gate) |
| Queue depth | `MAX_QUEUE_DEPTH` | `20` | in-process requests allowed to wait for a slot; `0` = reject immediately |
| Run timeout | `RUN_TIMEOUT_SECONDS` | `180` | hard wall-clock per run; frees the slot if exceeded |

Behavior: up to `MAX_CONCURRENT_RUNS` execute in parallel → next `MAX_QUEUE_DEPTH` wait → beyond that, `429 Too Many Requests` + `Retry-After` (backpressure, not collapse). Any run exceeding `RUN_TIMEOUT_SECONDS` is killed and its slot freed. Limits are **per-container** — true ceiling on ECS = `MAX_CONCURRENT_RUNS` × task count; a global cross-container cap is a v2 lever. In `worker`/SQS mode, SQS is the durable bounded queue (workers prefetch only up to free slots), so `MAX_QUEUE_DEPTH` applies mainly to `all`/`api` intake. Startup logs a warning if `MAX_CONCURRENT_RUNS × ~2 GB` exceeds container memory; `/v1/health` exposes live `runs_in_progress` / `queue_depth`.

## 10. Configuration System

Resolution per key: **payload `config` > environment > built-in default**. The fully resolved config is echoed in `meta.effective_config`.

| Key (payload) | Env var | Default | Notes |
|---|---|---|---|
| `playbook_self_heal` | `CONFIG_PLAYBOOK_SELF_HEAL` | `true` | §9.3 |
| `self_heal_on_extraction_failure` | `CONFIG_SELF_HEAL_ON_EXTRACTION_FAILURE` | `false` | |
| `run_timeout_seconds` | `RUN_TIMEOUT_SECONDS` | `180` | wall clock per run; a payload value is capped by `MAX_RUN_TIMEOUT_SECONDS` |
| `agent_max_steps` | `CONFIG_AGENT_MAX_STEPS` | `25` | agent guardrail |
| `model` | `CONFIG_MODEL` | (none — **required**) | agent + extract model as `provider/name` (e.g. `anthropic/claude-...`, `openai/gpt-4.1`, `google/gemini-...`, `ollama/llama3.1`); **no built-in default** — a run that needs a model with none set → `validation_error` |
| `evidence_capture` | `CONFIG_EVIDENCE_CAPTURE` | `true` | |
| `evidence_inline` | `CONFIG_EVIDENCE_INLINE` | `false` | embed base64 in envelope (local/air-gapped) |
| `proxy_enabled` | `CONFIG_PROXY_ENABLED` | `false` | per-run override allowed |
| `headless` | `CONFIG_HEADLESS` | `true` | |
| `allow_offsite` | `CONFIG_ALLOW_OFFSITE` | `false` | agent domain confinement |
| `replay_llm_fallback` | `REPLAY_LLM_FALLBACK` | `off` | structural-first; surfaced fallback (§9.2) |
| `replay_llm_fallback_model` | `REPLAY_LLM_FALLBACK_MODEL` | (unset) | `provider/name` model used only when the fallback engages |
| `force_relearn` | — (payload only) | `false` | §8.4 |

**Capacity limits are env-only and NOT payload-overridable** (a payload must never raise a container's resource ceilings): `MAX_CONCURRENT_RUNS`, `MAX_QUEUE_DEPTH`, `BROWSER_RECYCLE_RUNS`, `MAX_RUN_TIMEOUT_SECONDS` (see §9.4).

Non-overridable env-only settings: storage backends and paths/buckets, SQS settings, model-provider keys/endpoints (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OLLAMA_BASE_URL`), `SERVICE_MODE`, auth secrets, webhook signing secrets, proxy credentials. **Payload config can pick the provider/model but can never change where data is stored or sent, supply a provider key, or redirect a provider endpoint.**

```env
SERVICE_MODE=all | api | worker
PORT=8080
STORAGE_BACKEND=local | s3
STORAGE_LOCAL_PATH=/data
# (selector cache follows STORAGE_BACKEND — not a separate knob)
SQS_ENABLED=false
SQS_QUEUE_URL=                     # required when SQS_ENABLED — the run queue
SQS_RESULTS_QUEUE_URL=             # optional — publish the terminal envelope here
SQS_VISIBILITY_TIMEOUT_SECONDS=300 # must exceed RUN_TIMEOUT_SECONDS; consumer heartbeats to extend
# (DLQ is the SQS queue's own redrive policy — configured on the queue, not read by the engine)

# AWS / S3 (STORAGE_BACKEND=s3)
AWS_REGION=us-east-1
AWS_ENDPOINT_URL=                  # custom endpoint (e.g. LocalStack) for SQS + S3; unset → real AWS
S3_BUCKET=
S3_ENDPOINT=                       # optional S3-specific override (defaults to AWS_ENDPOINT_URL)

# Model providers — env-only secrets/endpoints; pick per-run via config.model = "provider/name"
CONFIG_MODEL=                      # default model for agent/heal/fallback when the payload omits it
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
OLLAMA_BASE_URL=                   # e.g. http://localhost:11434/v1 (OpenAI-compatible; local, no external call)
OPENAI_BASE_URL=                   # optional: OpenAI-compatible gateway (vLLM/LM Studio/OpenRouter/Azure)

WEBHOOK_SIGNING_SECRET=             # reserved — webhooks are unsigned in v1 (verification at the gateway, DECISIONS #32)
API_AUTH_MODE=none | api_key | hmac # only `none` is enforced in v1; api_key/hmac reserved (DECISIONS #32)
PROXY_URL=
DATABASE_URL=postgres://...        # run records + playbook index (Postgres everywhere)

# Concurrency & capacity (per container — see §9.4)
MAX_CONCURRENT_RUNS=3              # parallel browser runs; ~1 vCPU + 2GB each
MAX_QUEUE_DEPTH=20                # in-process requests allowed to wait for a slot; 0 = reject when full
RUN_TIMEOUT_SECONDS=180           # default hard wall-clock per run; frees the slot if exceeded
MAX_RUN_TIMEOUT_SECONDS=600       # ceiling a payload-supplied run_timeout_seconds cannot exceed
BROWSER_RECYCLE_RUNS=10           # recycle a Chromium process after N runs (memory hygiene)
SHUTDOWN_GRACE_SECONDS=25         # graceful-drain window on SIGTERM before forced exit

# Self-heal & replay LLM extraction fallback (see §9.2)
HEAL_FAILURE_THRESHOLD=3          # consecutive heal failures → playbook health=unhealthy
REPLAY_LLM_FALLBACK=off           # on | off
REPLAY_LLM_FALLBACK_MODEL=        # provider/name model used only when fallback engages
FALLBACK_AS_DRIFT_SIGNAL=false    # flag a playbook health=needs_relearn after K fallback engagements
FALLBACK_DRIFT_THRESHOLD=5        # K

# Security — SSRF egress guard + data handling (Phase 7)
ALLOW_PRIVATE_TARGETS=false       # dev convenience: permit ALL private hosts
ALLOWED_PRIVATE_CIDRS=            # prod: allowlist deliberate internal targets, e.g. 10.1.0.0/16
STORE_RUN_INPUTS=false            # off → run rows store data KEYS, not values
```

## 11. Evidence

- Captured at run end (and on failure, at point of failure): full-page screenshot (PNG) + serialized DOM (HTML), plus Playwright trace if `CONFIG_TRACE=true`.
- Stored under `evidence/{run_id}/` in the configured backend; envelope carries URLs (S3 signed, expiring) or engine-served paths (`/v1/runs/{id}/evidence`) in local mode.
- Retention is the deployer's concern (S3 lifecycle rules / local cron); the engine never deletes evidence itself.

## 12. Docker & Deployment

- Single image, `FROM mcr.microsoft.com/playwright:<pinned>`; Node 24 (latest LTS) + the engine. Entrypoint switches on `SERVICE_MODE`:
  - `all`: HTTP server + in-process job loop (laptop / single-container deployments).
  - `api`: HTTP only — validates, persists, enqueues (requires SQS).
  - `worker`: SQS consumer + execution only.
- `tini` as PID 1 (Chrome zombie reaping). One run = one browser context (never shared across runs — see §9.4); browser process recycled every `BROWSER_RECYCLE_RUNS` (default 10) to cap memory creep.
- Resource guidance: ~1 vCPU / 2 GB per concurrent run. Capacity is governed by three per-container limits — `MAX_CONCURRENT_RUNS`, `MAX_QUEUE_DEPTH`, `RUN_TIMEOUT_SECONDS` (see §9.4). Suggested 4 vCPU / 8 GB container → `MAX_CONCURRENT_RUNS=3`.
- Volumes (local mode): `-v ./data:/data` covers playbooks, cache, and evidence. Postgres runs as a sidecar container (see `docker-compose.yml`) or a managed instance via `DATABASE_URL`.
- Health: `/v1/health` reports browser launchability, storage reachability, and live saturation (`runs_in_progress`, `queue_depth`, `max_concurrent_runs`).

## 13. Security

- **SSRF**: `url` and agent navigation are confined to public internet by default; deny RFC1918 / link-local / metadata endpoints (169.254.169.254) at the network layer of the container and via URL validation. Config allowlist for intentionally internal targets (`ALLOWED_PRIVATE_CIDRS`).
- **Data sensitivity**: `data` values redacted in logs; never persisted into playbooks (templating only); run records store data keys, not values, unless `STORE_RUN_INPUTS=true`.
- **No credential handling in v1**: payloads must not contain login passwords; login flows are out of scope (Open Question for v2 — would require a secrets interface, not raw values in `data`).
- Webhooks unsigned in v1 and API auth `none` — both descoped to the trusted gateway (DECISIONS #32; `api_key`/`hmac`/`X-Engine-Signature` reserved). SQS trust = queue IAM.
- Playbooks are data, not code: the runner interprets a fixed op vocabulary; nothing from a playbook is ever `eval`'d.

## 14. Observability

- Structured JSON logs (run_id-scoped). Metrics (Prometheus endpoint `/metrics`): runs by mode/status, heal rate, agent token usage, p50/p95 duration by mode, playbook hit rate, per-playbook failure streaks.
- A playbook with N consecutive failed heals gets flagged `unhealthy` in meta.json and surfaced via `GET /v1/playbooks?health=unhealthy`.

## 15. Testing Strategy

- **Unit**: config resolver, payload validation, templating/provenance, envelope construction, step interpreter (against fixture DOMs via Playwright + local static pages).
- **Integration**: dockerized engine vs. a bundled fixture website (express app with forms/results pages) — covers agent run → compile → replay → mutate fixture site → self-heal, fully offline except the configured LLM provider's API (none, when using a local model such as Ollama).
- **Contract tests**: golden envelope fixtures; webhook delivery + retry (unsigned — signing descoped, DECISIONS #32).
- **Chaos**: kill browser mid-run, storage unavailable, SQS visibility expiry.

## 16. Implementation Phases (Claude Code roadmap)

1. **Skeleton**: repo, TS + Fastify, config resolver, payload schema (zod), run records (**Postgres** + migrations), envelope, `/v1/runs` + poll, `SERVICE_MODE=all`, Docker image + `docker-compose` (engine + Postgres).
2. **Playbook runner**: declarative step interpreter on Playwright, local playbook store, versioning + activate/rollback endpoints, evidence capture, fixture site + tests.
3. **Concurrency core**: per-run isolation (one context per run, no shared state), the semaphore + bounded queue (`MAX_CONCURRENT_RUNS` / `MAX_QUEUE_DEPTH`), `RUN_TIMEOUT_SECONDS` enforcement, `/v1/health` saturation, browser recycling. *(Build this before the agent so isolation is proven on the cheap path first.)*
4. **Agent engine**: Stagehand integration, action recording + provenance, compiler (steps + parameterization + output_format), playbook creation flow.
5. **Self-heal + LLM fallback**: failure classification, heal flow, version bump + pointer move, unhealthy flagging, surfaced replay LLM-extraction fallback.
6. **Transports & storage**: webhook delivery (unsigned — signing descoped to the gateway, DECISIONS #32), SQS consumer + DLQ + results queue, S3 backends, `api`/`worker` modes.
7. **Hardening**: SSRF guards, redaction, metrics, chaos tests (kill browser mid-run, storage loss, queue-full backpressure), docs.

## 17. Resolved Decisions & Open Questions

**Resolved (locked):**
- **Runtime**: TypeScript / Node 24 (latest LTS — see DECISIONS #10). (Stagehand is TS-native; matches the Kompliant MCP server stack; the AI sits behind a provider-agnostic LLM gateway — Anthropic / OpenAI / Google / local, see DECISIONS #11 — so no ML-lib pull.)
- **Run-record + playbook-index store**: PostgreSQL everywhere (one mental model; transactional `active_version` pointer moves; matches existing Postgres expertise). Playbook *bodies* and evidence remain blobs in local FS / S3.
- **Replay extraction**: structural-first with a configurable, always-surfaced LLM fallback — `REPLAY_LLM_FALLBACK` (on|off, env, payload-overridable) + `REPLAY_LLM_FALLBACK_MODEL`. When engaged it sets `meta.llm_fallback_used` and is counted per-playbook so drift is visible (§9.2).
- **Concurrency model**: three per-container env limits — `MAX_CONCURRENT_RUNS` / `MAX_QUEUE_DEPTH` / `RUN_TIMEOUT_SECONDS` — with full request-isolation invariants (§9.4). Global cross-container cap deferred to v2.

**Still open (don't block Phase 1):**
1. ~~**API auth v1** — none, static API keys, or HMAC request signing?~~ **Resolved:** `none` / trusted-gateway — in-engine API auth, API keys, and webhook signing are out of scope; an upstream gateway terminates them (DECISIONS #32).
2. **Synchronous mode** — support `POST /v1/runs?wait=true` (block up to N seconds, return envelope directly) for fast playbook replays? Convenient for callers; complicates timeouts.
3. **Login flows** — out for v1, but if v2 needs them, reserve a secrets reference (`data: { "password": { "$secret": "vault-key" } }`) now so the payload schema doesn't break later.
4. **List-valued data / iteration** ("do X for each item") — v2 confirmed, or needed sooner?
5. **Playbook portability** — exportable/importable across engine instances to share a learned library? Cheap given the file layout; affects ID generation.
6. **Name** — "engine" is a placeholder. This smells like a Warpmind project; got a name in mind?

