# ARCHITECTURE: Universal Instruction-Driven Browser Automation Engine

> Companion to `PROJECT_SPEC.md`. The spec defines *what* the engine does and its external contract; this document defines *how* it is built internally — components, mechanisms, data flows, and deployment topology.
>
> **Locked decisions:** Runtime **TypeScript / Node 24** (latest LTS). Run-record + playbook-index store **PostgreSQL everywhere**. Replay extraction is **structural-first with a configurable LLM fallback** that is always surfaced in the envelope.

---

## 1. Architectural Principles

1. **Two-speed execution.** Expensive AI exploration happens rarely (first contact, healing); cheap deterministic replay happens constantly. Every design choice optimizes the replay path for speed, cost, and reliability, and treats the agent path as the slow exception.
2. **Playbooks are data, never code.** A playbook is a declarative JSON document interpreted by a fixed op-vocabulary runner. Nothing learned by the LLM is ever `eval`'d. This is what makes playbooks safe to store, diff, version, transfer, and trust.
3. **Provenance over guessing.** The compiler knows which page interactions consumed which `data` values because the orchestrator records that mapping during the agent run. Templating is provenance-driven, not string-matched.
4. **Config flows one way, data never leaks.** Payload config can alter *behavior* but never *destinations* (storage, webhooks, queues are env-only). Sensitive `data` values are templated out of playbooks and redacted in logs.
5. **Same code, many shapes.** One image, one payload schema, one response envelope, one orchestrator — fronted by either HTTP or SQS, split into `api`/`worker`/`all` roles by config. No transport-specific business logic.
6. **Honest results.** The engine surfaces uncertainty rather than hiding it: structural-extraction misses, LLM fallback engagement, partial extraction, and heal events are all explicit in `meta`.

## 2. System Context

```
            ┌────────────┐      ┌────────────┐      ┌────────────┐
            │  Caller A  │      │  Caller B  │      │  Caller C  │
            │  (Rails)   │      │ (internal) │      │  (cron)    │
            └─────┬──────┘      └─────┬──────┘      └─────┬──────┘
                  │  HTTP POST /v1/runs   │  or  SQS enqueue │
                  └──────────────┬────────┴──────────────────┘
                                 ▼
                      ╔═══════════════════════╗
                      ║        ENGINE         ║
                      ║  (1..N containers)    ║
                      ╚═══════╤═══════╤═══════╝
            ┌──────────────┐  │       │  ┌──────────────────┐
            │  PostgreSQL  │◄─┘       └─►│  LLM provider API │
            │ runs+pb index│             │  (agent + extract)│
            └──────────────┘             └──────────────────┘
            ┌──────────────┐  ┌──────────────┐  ┌────────────┐
            │ Playbook Store│  │ Evidence Store│  │  Target    │
            │ local | S3   │  │  local | S3  │  │  Websites  │
            └──────────────┘  └──────────────┘  └─────┬──────┘
                                                       │ (optional
                                                  ┌────┴─────┐ residential
                                                  │  Proxy   │ proxy)
                                                  └──────────┘
```

External dependencies: PostgreSQL (always), the configured LLM provider's API (agent/heal/LLM-fallback only; none when using a local model like Ollama), object storage (S3 in cloud mode; filesystem in local mode), optional SQS, optional proxy provider.

## 3. Component Inventory

The engine is a modular monolith — one deployable, clean internal seams so components could later split into services if scale demands. Layers:

```
┌─────────────────────────────────────────────────────────────┐
│ TRANSPORT          HttpServer (Fastify)   │  SqsConsumer      │
├─────────────────────────────────────────────────────────────┤
│ INTAKE             PayloadValidator · ConfigResolver ·        │
│                    IdempotencyGuard · AuthGuard               │
├─────────────────────────────────────────────────────────────┤
│ ORCHESTRATION                 RunOrchestrator                 │
│                 (resolution logic · run lifecycle · heal)     │
├──────────────────────────┬──────────────────────────────────┤
│ EXECUTION                 │                                   │
│  PlaybookRunner (no LLM)  │   AgentEngine (Stagehand)         │
│  StepInterpreter          │   ActionRecorder                  │
│  StructuralExtractor      │   PlaybookCompiler                │
│  LlmExtractFallback ──────┼──► (ModelGateway)                 │
├──────────────────────────┴──────────────────────────────────┤
│ BROWSER            BrowserPool · BrowserContextFactory        │
│                    (Playwright · Chromium · proxy · stealth)  │
├─────────────────────────────────────────────────────────────┤
│ PERSISTENCE        PlaybookStore   EvidenceStore   RunStore   │
│                    (local|S3)      (local|S3)      (Postgres) │
│                    SelectorCache (local|S3)                   │
├─────────────────────────────────────────────────────────────┤
│ CROSS-CUTTING      Logger · Metrics · WebhookDispatcher ·     │
│                    SsrfGuard · Redactor                       │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Transport layer

- **HttpServer (Fastify)** — routes from spec §4.1; thin. Validates → enqueues internal job → returns 202 (or blocks if sync mode enabled). Serves evidence and playbook-admin endpoints.
- **SqsConsumer** — long-poll loop; message body = payload. Heartbeat-extends visibility for long agent runs; routes terminal failures to DLQ; optionally publishes envelopes to a results queue. Active only when `SQS_ENABLED=true` and `SERVICE_MODE ∈ {worker, all}`.

### 3.2 Intake layer

- **PayloadValidator** — Zod schema for the payload (spec §5); rejects with `validation_error` before any work. Enforces the resolution preconditions (instruction+url OR playbook_id present).
- **ConfigResolver** — produces the effective config by merging payload `config` ← env ← built-in defaults, per key (spec §10). Pure function; output stored on the run and echoed in `meta.effective_config`.
- **IdempotencyGuard** — `(caller, idempotency_key)` unique; a repeat returns the existing run's current envelope instead of launching a new browser session.
- **AuthGuard** — pluggable (`none | api_key | hmac`); see §9.

### 3.3 Orchestration layer

**RunOrchestrator** is the heart. It owns the run lifecycle state machine and the resolution logic (spec §5.3). It is transport-agnostic: it receives a validated job + effective config and returns/persists an envelope. Responsibilities: pick mode (playbook vs agent), invoke the right executor, classify failures, trigger heal, write run records and version pointers, dispatch webhooks. It never touches Playwright directly — it delegates to executors.

### 3.4 Execution layer

- **PlaybookRunner** — deterministic. Loads a version file, validates `data` against `required_data_keys`, drives **StepInterpreter** over the op list, runs **StructuralExtractor** for `extract` ops, optionally invokes **LlmExtractFallback**. No agent, no reasoning loop.
- **StepInterpreter** — maps each declarative op to Playwright calls; primary selector → `fallback_selectors` → `step_failed`. Evaluates `assertions`.
- **StructuralExtractor** — pulls fields using stored selectors/scope from the playbook; pure DOM. Per-field success/failure feeds extraction status.
- **LlmExtractFallback** — engaged only when structural extraction misses fields AND `REPLAY_LLM_FALLBACK=on`. Sends the page (DOM/screenshot) + output_format to the configured fallback model **via the `ModelGateway`**. **Always surfaced** (see §6.3) — the run is never silently "completed" when the LLM had to rescue it.
- **AgentEngine** — wraps Stagehand **v3.5** (`agent()`/`act()`/`observe()`/`extract()`), configured with the `model`/key resolved via the `ModelGateway`. Stagehand v3 is CDP-native and **owns its own browser** — one instance per agent run, disposed at run end (DECISIONS #21) — so agent runs do **not** use the Playwright `BrowserPool` (that stays the replay path's browser); both are isolated and both are gated by the `Lifecycle` (`executeAgent`: the semaphore + a wall-clock `AbortSignal` that cancels the agent on timeout). Enforces guardrails (step budget, domain confinement via `ssrf-guard`, CAPTCHA short-circuit, wall clock). The only module that imports Stagehand.
- **ActionRecorder** — observes the agent: records each effective action as `{op, selector, fallback_selectors, description, dataProvenance}` in order. The provenance field is the link from a typed value back to its `data` key (§4).
- **PlaybookCompiler** — turns the recorded action list into a version file: parameterizes values via provenance, attaches `output_format`, derives `required_data_keys`, writes the version + updates the index/meta.
- **ModelGateway** (`src/model/`) — resolves the `model` string (`provider/name`) to a provider + its **env-only** secret (key + optional base URL), and enforces **require-explicit**: there is no built-in default, so a run that needs a model with none resolved fails `validation_error`. As built in Phase 4 this is resolution + validation only — Stagehand bundles the Vercel AI SDK and owns the *agent's* model call; the gateway hands it the resolved `model`/key. The direct AI-SDK model client (for `LlmExtractFallback`) lands here in Phase 5. It is the only model entry point for both `AgentEngine` and `LlmExtractFallback`; the deterministic runner/interpreter/structural-extractor never import it (zero-LLM path).

### 3.5 Browser layer

- **BrowserPool** — manages Chromium processes; one context per run; recycles a process every `BROWSER_RECYCLE_RUNS`. Caps concurrency (`CONFIG_CONCURRENCY`).
- **BrowserContextFactory** — builds a context per effective config: `channel` (real Chrome vs bundled), viewport/locale/timezone, proxy wiring, headless flag, stealth defaults.

### 3.6 Persistence layer — see §5.

### 3.7 Cross-cutting

- **WebhookDispatcher** — HMAC-signs the envelope, POSTs to `callback_url`, retries (3×, backoff), records delivery status on the run.
- **SsrfGuard** — validates `url` and every agent navigation against deny rules (RFC1918, link-local, 169.254.169.254, loopback) unless explicitly allowlisted.
- **Redactor** — strips/masks `data` values from logs and traces.
- **Logger/Metrics** — structured run-scoped logs; Prometheus metrics (spec §14).

## 4. Core Mechanism: Record → Compile → Parameterize → Replay

This is the defining mechanism of the engine. Walked end to end:

### 4.1 During an agent run — provenance capture

The orchestrator hands the agent a `data` object and keeps a reverse index of value → key (`{"A123456": "license_number"}`). As the agent acts, **ActionRecorder** logs each interaction. When a `fill`/`select`/`press` writes a value, the recorder checks the reverse index:

- value matches a known `data` value → record `dataProvenance: "license_number"`.
- value is a literal the agent chose (e.g., selecting category "Physician") → record `literal: "Physician"`, no provenance.

Provenance is by **exact value identity tracked through the call**, not by scanning page text for the string — so a license number that happens to also appear as static page text never gets mis-templated.

```
Agent action stream (recorded):
  goto   https://mbc.ca.gov/lookup
  click  a[href*=lookup]            desc="open lookup"
  fill   #licNum   value=A123456    provenance=license_number
  fill   #lastNm   value=Nguyen     provenance=last_name
  select #type     value=Physician  literal=Physician
  click  button[type=submit]
  waitFor .results-table
  extract → output_format
```

### 4.2 Compilation

**PlaybookCompiler** transforms the stream into a version file:

```
fill #licNum value=A123456 provenance=license_number
        ──► { "op":"fill", "selector":"#licNum", "value":"{{data.license_number}}" }

select #type literal=Physician
        ──► { "op":"select", "selector":"#type", "value":"Physician" }   // baked in: it's process, not input
```

`required_data_keys` = the set of provenance keys seen (`["license_number","last_name"]`). `output_format` is attached verbatim. Each selector carries `fallback_selectors` from what Stagehand `observe()` surfaced as alternates.

### 4.3 Replay

**PlaybookRunner** binds the current call's `data` into `{{data.*}}` slots and interprets the ops with zero LLM. Identical structure to the agent run, but deterministic and ~50× cheaper.

### 4.4 Why declarative (not generated Playwright code)

| Concern | Declarative JSON ops | Generated TS code |
|---|---|---|
| Safety | Interpreted by fixed vocab; no eval | Must execute LLM-authored code |
| Versioning/diff | Clean JSON diffs | Noisy code diffs |
| Parameterization | Structural, exact | Fragile string interpolation |
| Portability | Trivially serializable | Runtime/dependency coupling |
| Cost of flexibility | Must maintain an op vocabulary | "Anything" — but unsafe |

The op vocabulary is the deliberate constraint that buys every other property. New ops are added as real needs appear.

## 5. Data Model & Storage

Three storage concerns, independently backed:

| Concern | Backend | Why |
|---|---|---|
| Run records + playbook index | **PostgreSQL (always)** | Queryable lifecycle, idempotency, dedupe, health rollups, transactional pointer moves |
| Playbook version files | local FS \| S3 | Blob-ish, versioned, portable; co-located layout (spec §8.1) |
| Evidence (screenshot/HTML/trace) | local FS \| S3 | Large blobs, lifecycle-managed by deployer |
| Selector cache (Stagehand) | local FS \| S3 | Optional speedup; regenerable |

Rationale for the split: Postgres gives transactional integrity for the **active_version pointer**, idempotency keys, and run queries (exactly the relational/SSL-aware Postgres patterns already in use at Kompliant). Playbook *bodies* and evidence are blobs that benefit from cheap object storage and a portable file layout — keeping them out of Postgres keeps rows small and lets a playbook library be copied between instances as files.

### 5.1 PostgreSQL schema (core tables)

```sql
-- One row per playbook (the task identity)
CREATE TABLE playbooks (
  id                 TEXT PRIMARY KEY,           -- pb_...
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  url                TEXT NOT NULL,
  instruction        TEXT NOT NULL,              -- for self-heal
  playbook_type      TEXT NOT NULL,              -- 'extraction' | 'action'
  required_data_keys TEXT[] NOT NULL DEFAULT '{}',
  active_version     INT  NOT NULL,
  health             TEXT NOT NULL DEFAULT 'healthy', -- 'healthy'|'unhealthy'
  consecutive_heal_failures INT NOT NULL DEFAULT 0,
  deleted            BOOLEAN NOT NULL DEFAULT false
);

-- Append-only version index (bodies live in PlaybookStore as vN.json)
CREATE TABLE playbook_versions (
  playbook_id   TEXT NOT NULL REFERENCES playbooks(id),
  version       INT  NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT NOT NULL,                  -- 'agent_initial'|'self_heal'|'manual'|'format_change'
  created_by_run TEXT,                          -- run_id that birthed it
  output_format JSONB,                          -- saved format (null for action)
  body_uri      TEXT NOT NULL,                  -- pointer into PlaybookStore
  PRIMARY KEY (playbook_id, version)
);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,             -- run_...
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL,                -- queued|running|completed|completed_with_extraction_errors|failed
  mode            TEXT,                         -- playbook|agent
  playbook_id     TEXT,
  playbook_version INT,
  self_healed     BOOLEAN NOT NULL DEFAULT false,
  llm_fallback_used BOOLEAN NOT NULL DEFAULT false,
  effective_config JSONB NOT NULL,
  result          JSONB,                        -- extracted output_format shape (migration 0002)
  error           JSONB,
  extraction_errors JSONB,
  data_keys       TEXT[] NOT NULL DEFAULT '{}', -- keys only; values never stored unless STORE_RUN_INPUTS
  evidence_uri    TEXT,
  callback_url    TEXT,
  webhook_status  TEXT,                         -- pending|delivered|failed
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);

CREATE TABLE idempotency_keys (
  caller          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caller, idempotency_key)
);
```

The `active_version` move during self-heal is a single transaction: insert `playbook_versions` row → update `playbooks.active_version` → mark run. No window where the pointer is dangling.

## 6. Execution Flows (sequences)

### 6.1 First run (agent mode → playbook born)

```
Caller → HttpServer:   POST /v1/runs {instruction,url,data,output_format,callback_url}
HttpServer → Intake:   validate · resolve config · idempotency · auth
HttpServer → Caller:   202 {meta:{run_id, status:queued, estimated_path:agent}}
HttpServer → Orchestrator (async job)
Orchestrator:          no playbook_id, instruction present → AGENT MODE
Orchestrator → BrowserPool:   acquire context (proxy? channel? per config)
Orchestrator → AgentEngine:   run(instruction, url, data, output_format)
  AgentEngine → ModelGateway → provider:  reasoning per step  (ActionRecorder logging w/ provenance)
  AgentEngine → Playwright:   navigate/fill/submit
  AgentEngine → extract():    output_format → Zod → result
Orchestrator → EvidenceStore: screenshot + html
Orchestrator → PlaybookCompiler: actions → vN.json (+ parameterize, required_keys, format)
PlaybookCompiler → PlaybookStore (body) + Postgres (playbooks, playbook_versions)
Orchestrator → RunStore:      runs row = completed, mode=agent, playbook_id, version=1
Orchestrator → WebhookDispatcher: signed envelope → callback_url
```

### 6.2 Replay (playbook mode, the common case)

```
Caller → POST /v1/runs {playbook_id, data}   (or SQS message)
Intake: validate · resolve config
Orchestrator: playbook_id present → load active_version (Postgres → body_uri → PlaybookStore)
Orchestrator: validate data vs required_data_keys  (fail-fast 422 if missing)
Orchestrator → PlaybookRunner:
  BrowserPool: acquire context
  StepInterpreter: goto/click/fill({{data.*}})/submit/wait   (NO LLM)
  StructuralExtractor: pull output_format fields from DOM
    └─ all fields ok → result complete
    └─ missing fields:
         REPLAY_LLM_FALLBACK=off → status=completed_with_extraction_errors
         REPLAY_LLM_FALLBACK=on  → LlmExtractFallback(model=REPLAY_LLM_FALLBACK_MODEL)
                                    → llm_fallback_used=true ALWAYS surfaced (§6.3)
  EvidenceStore: screenshot + html
Orchestrator → RunStore + WebhookDispatcher: envelope
```

### 6.3 Replay with LLM extraction fallback — surfacing rules

The fallback exists so a minor layout shift doesn't force a full heal, but it must never be invisible (a silent LLM rescue hides a degrading playbook). Rules:

- Engaged only if structural extraction misses ≥1 field **and** `REPLAY_LLM_FALLBACK=on`.
- When engaged, the run **always** sets `meta.llm_fallback_used = true` and lists which fields the LLM resolved in `meta.fallback_fields`.
- If the LLM fallback itself can't resolve a field → that field is an extraction error as normal.
- A run that needed the fallback is `completed` (data is correct) but is **counted in metrics** (`fallback_engaged_total`, per-playbook) so a playbook quietly drifting toward obsolescence is visible. Optional: `FALLBACK_AS_DRIFT_SIGNAL=on` flags the playbook for proactive re-learn after K fallback engagements.
- Config keys: `REPLAY_LLM_FALLBACK` (on|off, env; payload-overridable as `config.replay_llm_fallback`), `REPLAY_LLM_FALLBACK_MODEL` (env; payload-overridable as `config.replay_llm_fallback_model`).

### 6.4 Self-heal

```
PlaybookRunner → step_failed (selector + fallbacks exhausted)
Orchestrator: heal-eligible code? AND resolved playbook_self_heal == true?
  YES → same run continues, meta.mode=agent, meta.self_healed=true
        instruction = payload.instruction ?? playbooks.instruction (Postgres)
        AgentEngine.run(...) → compile v(n+1)
        Postgres TXN: insert version → bump active_version → reset consecutive_heal_failures
        envelope: completed, playbook_version=n+1
  NO  → failed envelope, error.heal_attempted=false
  HEAL FAILS → failed envelope, error.heal_attempted=true, heal_outcome=...
               Postgres: consecutive_heal_failures++ ; if ≥ THRESHOLD → health=unhealthy
```

## 7. Browser Management

- **Process model:** one Playwright `BrowserContext` per run (clean cookies/storage), N contexts per Chromium process, process recycled every `BROWSER_RECYCLE_RUNS` to bound memory. `tini` as PID 1 reaps Chrome zombies.
- **Concurrency:** a semaphore of size `MAX_CONCURRENT_RUNS` gates context acquisition; SQS prefetch and the internal job loop both respect it so a container never oversubscribes its CPU/RAM (budget ~1 vCPU / 2 GB per concurrent run). See §8 for the full three-limit model (concurrent / queued / timeout).
- **Stealth posture (v1, conservative):** real-Chrome `channel` option, realistic viewport/locale/timezone (locale derivable from target or config), standard navigator hardening Playwright provides. No CAPTCHA solving — `captcha_detected` short-circuits to a clean failure.
- **Proxy:** when `proxy_enabled` (env default, per-run overridable), context launches through `PROXY_URL` with env-only credentials. Per-playbook "needs proxy" can be encoded later as a stored hint; v1 keeps it a config decision.
- **SSRF confinement:** `BrowserContextFactory` + `SsrfGuard` block private/link-local/metadata targets; agent navigation is confined to the target's registrable domain unless `allow_offsite`.

## 8. Concurrency, Request Isolation, Scaling, Reliability

The engine is designed to serve many requests at the same time in production. This section is the normative statement of how concurrent requests stay isolated, how many run at once, and how the system scales from a single Docker container to ECS. **The isolation invariants (§8.1) are correctness requirements, not optimizations — they must hold regardless of the concurrency limits in §8.2.**

### 8.1 Request isolation invariants

A "request" is a fully isolated unit of work. It owns everything it mutates and shares only things that are read-only or per-connection-safe. The following are hard invariants:

1. **One `BrowserContext` per run.** Each run creates its own Playwright `BrowserContext` at start and closes it at end. A context is its own cookie jar, localStorage, sessionStorage, and cache — so one run's session/auth/form state can never leak into another, even against the same target site. The Chromium **process** may be shared across contexts (cheaper than launching Chrome per run); the **context** never is. *Page objects, contexts, and Stagehand instances are per-run and never pooled or reused across runs.* The tempting "reuse the page to save startup time" optimization is explicitly forbidden — it is the primary way cross-request contamination is introduced.
2. **No shared mutable state in the orchestrator.** Each run carries its own state object (`run_id`, bound `data`, resolved config, action recorder, evidence paths). Nothing about a run is read from or written to module-level variables, singletons, or global maps keyed by anything ambient. The orchestrator receives the run context as an explicit argument and threads it through; it never reads "the current run" from shared scope. (In Node this is the classic concurrency footgun: a module-scope `let currentRun` works in single-request dev and silently corrupts under load.)
3. **Per-run data binding.** `{{data.*}}` substitution resolves against *this run's* data object, passed explicitly into the step interpreter. The provenance reverse-index (value→key) is built fresh per run and discarded at run end. There is no shared "current data" structure.
4. **Keyed writes, never shared paths.** Evidence is written under `evidence/{run_id}/`; playbook bodies under `(playbook_id, version)` paths unique by construction. No shared filenames, no `latest.*` that races.
5. **Postgres concurrency-safety.** Each run borrows a pooled connection for its writes and returns it. The `active_version` pointer move is a single transaction (insert version → bump pointer) so two concurrent heals of the *same* playbook cannot interleave into a corrupt state. Idempotency keys carry a unique constraint, so a double-submitted request cannot create two runs.

```
Run A ─┐ owns: context_A, run_row_A, data_binding_A, recorder_A, evidence/A/
Run B ─┼─ owns: context_B, run_row_B, data_binding_B, recorder_B, evidence/B/   ← nothing mutable shared
Run C ─┘ owns: context_C, run_row_C, data_binding_C, recorder_C, evidence/C/
  shared (safe): playbook store (read-only), resolved config (frozen per run),
                 Postgres connection pool (per-connection), Chromium process (per-context)
```

### 8.2 Concurrency limits (three distinct knobs)

Conflating "how many run at once" with "how many may wait" with "how long one may run" is what causes either OOM crashes or silent request drops. The engine separates them:

| Limit | Env var | Governs | Failure it prevents |
|---|---|---|---|
| **Concurrent runs** | `MAX_CONCURRENT_RUNS` | How many runs hold a browser context simultaneously | OOM from too many parallel Chromium instances |
| **Queue depth** | `MAX_QUEUE_DEPTH` | How many requests may wait for a slot (in-process, `all`/`api` intake) | Unbounded in-memory backlog collapsing the container on a spike |
| **Run timeout** | `RUN_TIMEOUT_SECONDS` | Hard wall-clock per run | A wedged run permanently holding a slot, shrinking effective concurrency to zero over time |

Resulting behavior under load:

```
incoming request
   │
   ├─ a slot free?            → run now           (up to MAX_CONCURRENT_RUNS in parallel)
   ├─ no slot, queue space?   → wait in queue     (up to MAX_QUEUE_DEPTH waiting)
   └─ no slot, queue full?    → 429 Too Many Requests + Retry-After   (backpressure, not collapse)

any run exceeding RUN_TIMEOUT_SECONDS → killed, context torn down, slot freed, `timeout` error
```

Notes that matter for prod:

- **These limits are per-container, not global.** On ECS with 5 worker tasks each at `MAX_CONCURRENT_RUNS=3`, the true ceiling is 15 — and no single env var knows that, which is correct: each container governs only itself, and total throughput scales by adding tasks. A *global* cap (politeness to a target site, total proxy-cost bound) is a separate mechanism — a distributed limiter (e.g. Redis token bucket) or simply letting SQS depth × task count bound it. v1 stays per-container; global limiting is a noted v2 lever (§14).
- **`MAX_QUEUE_DEPTH` is the in-process waiting room.** It applies to `all` mode (and to `api` mode's enqueue path). In `worker`/SQS mode, **SQS itself is the bounded queue** — workers prefetch only up to their free slots, and excess work simply stays on the queue, so `MAX_QUEUE_DEPTH` is effectively unbounded-but-durable there. `MAX_QUEUE_DEPTH=0` means "never queue, reject immediately when full" for callers that prefer fast failure over waiting.
- **Startup sanity check.** On boot the engine logs a warning if `MAX_CONCURRENT_RUNS × ~2 GB` exceeds detectable container memory — this catches the classic "set it to 10 on a 4 GB box" misconfiguration before it OOMs in production.
- **Live saturation visibility.** `/v1/health` exposes `runs_in_progress`, `queue_depth`, and `max_concurrent_runs` so an orchestrator (or a human) can see saturation and autoscaling can react. The same numbers are Prometheus gauges.
- **`MAX_CONCURRENT_RUNS` is a resource gate only, never a correctness mechanism.** Runs are isolated (§8.1) at any value; this knob only decides how many isolated runs share the box before new ones wait or bounce.

Recommended starting values: a 4 vCPU / 8 GB container → `MAX_CONCURRENT_RUNS=3`, `MAX_QUEUE_DEPTH=20`, `RUN_TIMEOUT_SECONDS=180`. Tune `MAX_CONCURRENT_RUNS` up only while watching memory headroom.

### 8.3 Topologies

```
LOCAL / SINGLE CONTAINER (SERVICE_MODE=all)
  ┌───────────────────────────────────┐
  │ HTTP + internal job loop + browser│  Postgres (container or local)
  │ storage = local FS                │  no SQS
  └───────────────────────────────────┘
  docker run -v ./data:/data -e DATABASE_URL=... image

CLOUD / SCALED (ECS Fargate)
  API tasks (SERVICE_MODE=api)  ──enqueue──►  SQS  ──►  Worker tasks (SERVICE_MODE=worker)
        │ validate/persist                                  │ execute + browser
        └──────────────► Postgres (RDS) ◄───────────────────┘
                          S3 (playbooks, evidence, cache)
  Worker autoscaling target: SQS ApproximateNumberOfMessages / backlog-per-task
```

- **API tasks** are cheap and stateless (no browser) → scale on request rate.
- **Worker tasks** are heavy (browser) → scale on queue depth; each runs its own small `MAX_CONCURRENT_RUNS`.
- **`all` mode** is for laptops and small single-box deploys; the same semaphore governs both the inline job loop and the browser pool, and `MAX_QUEUE_DEPTH` bounds the in-memory waiting room.

### 8.4 Reliability

- **Idempotency** dedupes caller retries (Postgres unique key) — a redelivered SQS message or a double POST never doubles a browser run.
- **At-least-once + idempotent effects:** SQS redelivery on worker crash is safe because run creation is keyed; an in-flight run that crashed is retried, and evidence/version writes are idempotent on `run_id`/`(playbook_id,version)`.
- **Visibility heartbeat:** worker extends SQS visibility while a long agent run proceeds; exceeds `run_timeout_seconds` margin.
- **DLQ:** poison messages (repeated validation/crash) land in `SQS_DLQ_URL` for inspection.
- **Pointer safety:** active_version moves are single Postgres transactions; readers always see a consistent (id, active_version, body) triple.
- **Graceful drain:** SIGTERM stops intake, lets in-flight runs finish within a grace window, then exits — Fargate deploys don't sever live browser sessions abruptly.

### 8.5 Failure isolation

A crashing run kills only its own context; the pool replaces it, and other in-flight runs are unaffected (§8.1). A wedged Chromium is caught by the per-run `RUN_TIMEOUT_SECONDS` wall clock → context torn down → slot freed → `timeout` error returned. Process recycling (`BROWSER_RECYCLE_RUNS`) caps cumulative memory leaks across runs that share a Chromium process; the pool recycles a process only once its in-flight contexts have drained, and exposes a monotonic `generation` counter as the recycle-observable proxy (Playwright does not surface the OS PID — DECISIONS #19). The pool keys browsers by `headless` mode, so headed and headless runs never share a process.

## 9. Security Architecture

- **Auth (pluggable, `API_AUTH_MODE`):** `none` (private network), `api_key` (per-caller keys, hashed at rest, used as the idempotency `caller` scope), `hmac` (KSig1-style request signing — recommended for parity with Kompliant). SQS path trust = queue IAM.
- **Webhook integrity:** HMAC-SHA256 over raw body, `X-Engine-Signature`, per-caller secret; callers verify before trusting.
- **SSRF:** deny RFC1918 / 169.254.0.0/16 / loopback / link-local for `url` and all agent navigation; `ALLOWED_PRIVATE_CIDRS` opt-in for deliberate internal targets.
- **Secrets & data:** model-provider keys/endpoints (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OLLAMA_BASE_URL`), proxy creds, webhook secrets, DB creds are env/secret-manager only, never in payloads. `data` values are redacted in logs and **never** persisted into playbook bodies (provenance templating guarantees only `{{data.*}}` refs are stored). Run rows store data *keys*, not values, unless `STORE_RUN_INPUTS=true` (off by default).
- **No code execution from learned artifacts:** the runner interprets a fixed op vocabulary; a playbook can never introduce executable code.
- **Tenancy note:** v1 is single-trust-domain. `caller` scoping on keys/idempotency is the seam along which per-tenant isolation (separate playbook namespaces, quotas) would later be added.

## 10. Configuration Resolution (mechanism)

```
effectiveConfig(key) =
   payload.config[key]            if present and key is payload-overridable
   else env[CONFIG_<KEY>]         if set
   else builtinDefault[key]
```

- One pure `ConfigResolver` consumed everywhere; result frozen onto the run and emitted in `meta.effective_config`.
- **Overridable** (behavior): self-heal flags, `run_timeout_seconds` (a caller may shorten its own run; a hard ceiling `MAX_RUN_TIMEOUT_SECONDS` caps it), agent_max_steps, model (`provider/name`; **required**, no built-in default), evidence_capture/inline, proxy_enabled, headless, allow_offsite, replay_llm_fallback(+model), force_relearn.
- **Env-only** (destinations, secrets, capacity): storage backends/paths/buckets, SQS, DB, model-provider keys/endpoints, auth/webhook secrets, proxy URL/creds, service mode, and the **capacity limits** `MAX_CONCURRENT_RUNS` / `MAX_QUEUE_DEPTH` / `BROWSER_RECYCLE_RUNS` (§8.2 — a payload must never raise the container's own resource ceilings). *Payload config can never redirect where data is stored or sent, nor raise capacity limits.*

Concurrency & capacity env (see §8.2):

```env
MAX_CONCURRENT_RUNS=3          # parallel browser runs; ~1 vCPU + 2GB each (per container)
MAX_QUEUE_DEPTH=20             # in-process requests allowed to wait for a slot; 0 = reject when full
RUN_TIMEOUT_SECONDS=180        # default hard wall-clock per run; frees the slot if exceeded
MAX_RUN_TIMEOUT_SECONDS=600    # ceiling a payload-supplied run_timeout_seconds cannot exceed
BROWSER_RECYCLE_RUNS=10        # recycle a Chromium process after N runs (memory hygiene)
```

## 11. Observability

- **Logs:** structured JSON, `run_id`-scoped, redacted; agent step traces at debug.
- **Metrics (Prometheus `/metrics`):** `runs_total{mode,status}`, `heal_total{outcome}`, `fallback_engaged_total{playbook_id}`, `agent_tokens_total`, `run_duration_seconds{mode}` (histogram), `playbook_hit_ratio`, `webhook_delivery_total{status}`, and saturation gauges `runs_in_progress`, `queue_depth`, `max_concurrent_runs`, plus `requests_rejected_total{reason="queue_full"}`.
- **Health (`/v1/health`):** reports `runs_in_progress`, `queue_depth`, `max_concurrent_runs` alongside browser-launchability and storage reachability, so autoscaling and operators can see live saturation.
- **Health signals (playbooks):** per-playbook `consecutive_heal_failures` and fallback-engagement counts roll into the `health` column; `GET /v1/playbooks?health=unhealthy` surfaces them. These are the early-warning system for site drift across the whole library.

## 12. Module / Directory Layout (TypeScript)

```
src/
  transport/      http-server.ts  sqs-consumer.ts  routes/
  intake/         payload-schema.ts  config-resolver.ts  idempotency.ts  auth.ts
  orchestrator/   run-orchestrator.ts  resolution.ts  heal.ts  lifecycle.ts
  execution/
    playbook/     runner.ts  step-interpreter.ts  structural-extractor.ts  llm-fallback.ts
    agent/        agent-engine.ts  action-recorder.ts  provenance.ts  compiler.ts  recorded-action.ts
  model/          model-gateway.ts          # resolves model "provider/name" → provider+env key (DECISIONS #11)
  browser/        pool.ts  context-factory.ts  ssrf-guard.ts
  persistence/
    runs/         run-store.pg.ts
    playbooks/    index.pg.ts  store.local.ts  store.s3.ts  store.ts
    evidence/     evidence.local.ts  evidence.s3.ts
    cache/        selector-cache.ts
  shared/         logger.ts  metrics.ts  webhook.ts  redactor.ts  envelope.ts  config.ts  ids.ts
  types/          payload.ts  playbook.ts  envelope.ts  run.ts
test/
  unit/  integration/  fixtures/site/   # bundled express fixture website
Dockerfile  docker-compose.yml          # engine + postgres for local
migrations/                             # Postgres (node-pg-migrate or similar)
```

Storage interfaces (`PlaybookStore`, `EvidenceStore`) have `local` + `s3` implementations chosen at boot by config; everything above the persistence layer is backend-agnostic.

## 13. Key Trade-offs (explicit)

| Decision | Chosen | Alternative | Why |
|---|---|---|---|
| Runtime | TypeScript/Node | Python | Stagehand is TS-native; matches existing stack; AI is behind an API so no ML-lib pull |
| Playbook form | Declarative JSON ops | Generated TS code | Safety (no eval), diffable, exact parameterization, portable |
| Run store | Postgres everywhere | sqlite+Dynamo split | One mental model; transactional pointer moves; matches Kompliant Postgres expertise |
| Playbook bodies | Object store (file layout) | In Postgres | Portable library, small rows, S3 lifecycle |
| Replay extraction | Structural + surfaced LLM fallback | Pure structural / always-LLM | Resilience without hidden cost or silent drift |
| Shape | Modular monolith | Microservices | Right-sized; clean seams allow later split |
| Delivery | At-least-once + idempotency | Exactly-once | Simpler, robust; idempotent effects make dupes safe |

## 14. What I'd Revisit as It Grows

- **Worker/browser split:** if browser cost dominates, move the BrowserPool behind its own CDP service (a self-hosted Browserbase) so workers stay light and browsers scale independently.
- **Per-tenant isolation:** promote `caller` to a first-class tenant with namespaced playbooks and quotas when this becomes a shared/productized API.
- **Iteration & multi-page data:** list-valued `data` and "for each row" flows need a loop op and a result-array envelope variant — a deliberate v2 design.
- **Login/secrets:** a `{"$secret":"ref"}` resolution layer (never raw creds in `data`) to unlock authenticated targets.
- **Playbook portability/export:** signed playbook bundles to share a learned library across environments.
- **Global concurrency limiter:** §8.2 limits are per-container. A cross-container global cap (politeness to a target site, total proxy-cost ceiling) would add a distributed limiter (Redis token bucket) keyed by target domain — worth it once many workers hit the same registries.
- **Smarter drift detection:** canary replays of known-good inputs per playbook to catch breakage before a real caller hits it.
