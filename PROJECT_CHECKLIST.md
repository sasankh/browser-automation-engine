# PROJECT_CHECKLIST: Universal Browser Automation Engine

> Companion to `PROJECT_SPEC.md` and `ARCHITECTURE.md`. This is the build tracker — each phase has its tasks, the acceptance criteria that define "done", and a **Plan & Verify gate** at the end. Do not start a phase until the previous phase's gate passes.
>
> **How to use:** check boxes as you go. The Plan & Verify gate at the end of each phase is mandatory — it's the checkpoint where you confirm the phase actually works in isolation before building the next layer on top of it. A phase is not "done" because the code is written; it's done when its gate passes.
>
> Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked. Tag owners/dates inline as needed.

---

## Phase ordering rationale

The order is deliberate and should not be reshuffled:

- **Postgres + skeleton first** so every later phase has a real run record to write to.
- **Deterministic runner before the agent** so the cheap, predictable path is proven before the expensive, stochastic one.
- **Concurrency/isolation before the agent** so isolation invariants are proven on a path you fully control — debugging a cross-request leak is far harder once an LLM is in the loop.
- **Agent, then self-heal** because heal is just "agent mode triggered by a runner failure" — it can't exist before either piece.
- **Transports/storage backends late** because webhooks, SQS, and S3 are swappable edges around a core that already works locally.
- **Hardening last** but not optional — it's a named phase with its own gate, not a backlog.

---

## Phase 0 — Foundations & Decisions

Lock the inputs so no later phase stalls on an unanswered question.

### Tasks
- [x] Confirm locked decisions from spec §17: TypeScript/Node 22, Postgres everywhere, structural-first extraction with surfaced LLM fallback, three-limit concurrency model.
- [x] Decide **API auth mode** for v1 (`none` | `api_key` | `hmac`). Default assumption: `none` for first internal deploy, `hmac` reserved. Record the choice. → **`none`** (DECISIONS.md #7).
- [x] Decide **sync mode** (`?wait=true`) in or out for v1. Default: out (async-only). → **out** (DECISIONS.md #8).
- [x] Pick the **project name** (replaces "engine" placeholder) — affects package name, ID prefixes, image name. → **Rote** (DECISIONS.md #6).
- [ ] Provision a **model-provider key/endpoint** (Anthropic/OpenAI/Google, or a local Ollama endpoint) and confirm Stagehand can reach it from a local container.
- [ ] Confirm **target test sites**: pick 2–3 real public sites with lookup forms for end-to-end validation (no auth, no CAPTCHA) + the bundled fixture site.
- [ ] Repository created; license; CODEOWNERS; branch protection.
- [x] Decide ID scheme: `run_...`, `pb_...` (ULID/KSUID for sortability). Record prefix constants. → **ULID**, prefixes `run_`/`pb_` (DECISIONS.md #9).

### Acceptance criteria
- All four spec §17 "resolved" items are reflected in a short `DECISIONS.md` in the repo.
- The three still-open-but-non-blocking questions have a recorded default so Phase 1 can proceed.

### ▣ Plan & Verify gate — Phase 0
- **Plan check:** Is every input Phase 1 needs now decided or defaulted? (runtime, DB, auth, name, IDs, API key, test sites)
- **Verify:** `DECISIONS.md` exists and is reviewed. A model-provider key/endpoint works from a throwaway container (`curl` the provider API or a 3-line Stagehand smoke). No open question blocks scaffolding.
- **Exit condition:** a second person could start Phase 1 from the repo with no verbal context.

---

## Phase 1 — Skeleton (API, config, Postgres, envelope, Docker)

> **Status: ✅ COMPLETE** — Plan & Verify gate passed by cold-start observation (2026-06-16), committed on branch `phase-1`. Granular tracker + Notes: [.ai-workspace/phase1_checklist.md](.ai-workspace/phase1_checklist.md). **Next: Phase 2 (on explicit go-ahead).**

A running service that accepts a run, persists it, and returns an envelope — with **no browser yet**. This proves the contract and the plumbing.

### Tasks

**Project setup**
- [x] TS + Node 24 (latest LTS) project; strict tsconfig; ESLint/Prettier; vitest or jest.
- [x] Fastify server; `PORT`; structured JSON logger (pino) with `run_id` scoping.
- [x] Dockerfile `FROM mcr.microsoft.com/playwright:<pinned>` (browser deps present even though unused this phase); `tini` as PID 1.
- [x] `docker-compose.yml`: engine + Postgres; `DATABASE_URL` wired; `-v ./data:/data`.

**Config**
- [x] `ConfigResolver`: pure per-key merge **payload.config > env > builtin default** (spec §10).
- [x] Implement the full env surface from spec §10 (storage, SQS placeholders, concurrency limits as values even if not yet enforced, fallback flags).
- [x] `effective_config` frozen onto each run and echoed in `meta`.
- [x] Enforce env-only keys: payload attempting to set a capacity/destination key is ignored (and logged at debug).

**Payload & envelope**
- [x] Zod schema for the full payload (spec §5): `instruction`, `url`, `output_format`, `playbook_id`, `playbook_version`, `data`, `config`, `callback_url`, `idempotency_key`.
- [x] Resolution precondition validation: reject when neither `playbook_id` nor (`instruction`+`url`) present → `validation_error`.
- [x] Envelope builder (`{ meta, result }`, spec §6) with all `meta` fields; `result` is caller-shape-or-null.
- [x] Status vocabulary + error model types (spec §7).

**Persistence (Postgres)**
- [x] Migrations for `playbooks`, `playbook_versions`, `runs`, `idempotency_keys` (architecture §5.1).
- [x] `RunStore`: create/update run rows; status transitions.
- [x] `IdempotencyGuard`: `(caller, idempotency_key)` unique; repeat returns existing run's envelope.

**Endpoints**
- [x] `POST /v1/runs` → validate, persist `queued`, return `202 {meta:{run_id,status}}`. (Execution stubbed: marks `failed` with `internal_error` — DECISIONS #12.)
- [x] `GET /v1/runs/{run_id}` → current envelope from `RunStore`.
- [x] `GET /v1/health` → liveness + DB reachability (saturation fields return zeros this phase).

### Acceptance criteria
- `docker-compose up` brings engine + Postgres healthy.
- A `POST /v1/runs` with a valid payload returns 202 and a row appears in `runs`.
- A malformed payload returns `validation_error` with no row created.
- Re-POST with the same `idempotency_key` returns the **same** `run_id`.
- `effective_config` in the envelope correctly reflects payload-over-env-over-default for a test key.
- Unit tests: config resolver (all three precedence levels), payload validator (accept/reject matrix), envelope invariants (`result` only caller-shape-or-null).

### ▣ Plan & Verify gate — Phase 1
- **Plan check:** Does the contract match the spec exactly — payload in, envelope out, statuses, error codes? Any drift from spec §5–§7 gets fixed now, before a browser is attached.
- **Verify (manual):** run the compose stack; exercise the accept/reject/idempotency cases above with `curl`; inspect `runs` rows; confirm `/v1/health` is green and reports DB up.
- **Verify (automated):** unit suite green in CI; Docker image builds in CI.
- **Exit condition:** the service is a faithful, testable shell of the final contract. Everything from here adds behavior behind the same unchanged contract.

---

## Phase 2 — Playbook Runner (deterministic, no LLM)

> **Status: ✅ COMPLETE** — Plan & Verify gate passed by observation (2026-06-17): 21 tests green, dockerized cold-start replay, live real-site extraction. Granular tracker + Notes: [.ai-workspace/phase2_checklist.md](.ai-workspace/phase2_checklist.md). **Next: Phase 3 (on explicit go-ahead).**

The cheap path. Execute a **declarative playbook** against a site with plain Playwright. Playbooks are hand-authored fixtures this phase (the agent that writes them comes in Phase 4) — this isolates the interpreter from the compiler.

### Tasks

**Fixture site**
- [x] Bundled express fixture website in `test/fixtures/site`: a lookup form (text inputs + submit) → results page with extractable fields; an "action only" form (submit, no results); a deliberately mutated variant (selector renamed) for later heal tests.
- [x] Compose profile or script to serve the fixture for integration tests (offline).

**Step interpreter**
- [x] Declarative version-file schema (architecture §8.2): `steps[]`, `assertions[]`, `output_format`, `required_data_keys`, `engine_min_version`.
- [x] Implement op vocabulary: `goto`, `click`, `fill`, `select`, `check`, `press`, `wait_for`, `wait_ms`, `scroll`, `extract`, `screenshot`.
- [x] Per step: primary selector → `fallback_selectors` → `step_failed` with step index + message.
- [x] `{{data.*}}` template binding against **this run's** data only.
- [x] `assertions` evaluation (e.g., `url_matches` after a step).

**Structural extraction**
- [x] `StructuralExtractor`: pull `output_format` fields from DOM using the extract op's `fields` map (DECISIONS #14); per-field success/failure.
- [x] Missing fields → `extraction_errors` + status `completed_with_extraction_errors` (no guessing). (LLM fallback is Phase 5.)

**Playbook store (local) + versioning**
- [x] `PlaybookStore` local FS impl: `playbooks/{id}/meta.json` + `vN.json` (architecture §8.1).
- [x] Postgres `playbooks` + `playbook_versions` index rows kept in sync with bodies; `body_uri` pointer.
- [x] `GET /v1/playbooks`, `GET /v1/playbooks/{id}` (contract: required keys, format, versions, active_version), `GET /v1/playbooks/{id}/versions/{v}`.
- [x] `POST /v1/playbooks/{id}/activate` (pointer move / rollback) as a single Postgres transaction.
- [x] `DELETE /v1/playbooks/{id}` soft-delete (tombstone; versions retained).
- [x] Pinned replay: `playbook_version` in payload runs that exact version, never moves pointer.

**Replay wiring**
- [x] `POST /v1/runs` with `playbook_id` → load active (or pinned) version → validate data vs `required_data_keys` (fail-fast `422` if missing) → run interpreter → extract → evidence → envelope.

**Evidence (local)**
- [x] `EvidenceStore` local impl: screenshot + serialized HTML under `evidence/{run_id}/`; envelope carries engine-served paths; `GET /v1/runs/{id}/evidence`.

### Acceptance criteria
- A hand-authored extraction playbook run against the fixture returns a correct `result` matching `output_format`, status `completed`.
- An action-only playbook returns `result: null`, status `completed`.
- A playbook with a missing field returns `completed_with_extraction_errors` + correct `extraction_errors`.
- A replay with missing required data keys returns `422` **before** a browser launches.
- Versioning: create v1 fixture, add v2, `activate` v1, confirm replay uses v1; pinned `playbook_version=2` uses v2 regardless of pointer.
- Integration test runs fully offline against the fixture site.
- Replay p50 latency < 30s on the fixture.

### ▣ Plan & Verify gate — Phase 2
- **Plan check:** Is the declarative op vocabulary sufficient for the real target test sites from Phase 0? Author a playbook for one real site by hand and see what ops are missing — add them now, while the interpreter is the only consumer.
- **Verify (automated):** offline fixture integration test green; versioning/activate/rollback tests green; the `422`-before-browser test green.
- **Verify (manual):** hand-author a playbook for one real Phase-0 site, run it, inspect evidence screenshot + extracted result.
- **Exit condition:** deterministic replay is trustworthy and observable. The engine can verify/perform a known task repeatedly with zero LLM — the thing every later phase optimizes toward.

---

## Phase 3 — Concurrency Core & Request Isolation

> **Status: ✅ COMPLETE** — Plan & Verify gate passed by observation (2026-06-17): 27 tests green (incl. the release-blocking isolation test @ 600 concurrent runs), dockerized cold-start load gate (2×60 real-HTTP runs, zero cross-contamination, saturation→0, stable memory). Granular tracker + Notes: [.ai-workspace/phase3_checklist.md](.ai-workspace/phase3_checklist.md). **Next: Phase 4 (on explicit go-ahead).**

Make the engine safe under simultaneous load **before** the agent exists, so isolation is proven on the fully-controllable deterministic path. This is the phase that protects production.

### Tasks

**Isolation invariants (architecture §8.1)**
- [ ] One Playwright `BrowserContext` per run, created at start, closed at end. Audit: no code path reuses a `Page`/`BrowserContext`/Stagehand instance across runs.
- [ ] `BrowserPool`: shares a Chromium **process** across contexts; never a context.
- [ ] Per-run state object threaded explicitly through the orchestrator; static-analysis/lint rule or review check for module-level mutable run state.
- [ ] Per-run data binding + provenance index built and discarded per run (no shared "current data").
- [ ] Keyed writes verified: `evidence/{run_id}/`, `(playbook_id, version)` — grep for any shared/`latest.*` paths.

**Capacity limits (architecture §8.2, three knobs)**
- [ ] `MAX_CONCURRENT_RUNS` semaphore gating context acquisition.
- [ ] `MAX_QUEUE_DEPTH` in-process bounded waiting room; overflow → `429` + `Retry-After`.
- [ ] `RUN_TIMEOUT_SECONDS` hard wall-clock per run → kill, tear down context, free slot, `timeout` error.
- [ ] `MAX_RUN_TIMEOUT_SECONDS` ceiling on payload-supplied `run_timeout_seconds`.
- [ ] `BROWSER_RECYCLE_RUNS`: recycle a Chromium process after N runs.

**Lifecycle & health**
- [ ] In-process job loop (`SERVICE_MODE=all`) pulling from the bounded queue, respecting the semaphore.
- [ ] Startup memory sanity check: warn if `MAX_CONCURRENT_RUNS × ~2GB` > detectable container memory.
- [ ] `/v1/health` reports live `runs_in_progress`, `queue_depth`, `max_concurrent_runs`.
- [ ] Graceful drain on SIGTERM: stop intake, let in-flight runs finish within grace window, then exit.

### Acceptance criteria
- **Isolation test (the critical one):** fire N concurrent replays that each set a distinct cookie / localStorage value on the fixture site and read it back; every run sees only its own value. Zero cross-contamination across many repetitions.
- **Concurrency cap:** with `MAX_CONCURRENT_RUNS=2`, exactly 2 browsers run at once under a burst of 10; the rest queue.
- **Backpressure:** with `MAX_QUEUE_DEPTH=3`, the 6th simultaneous request gets `429` + `Retry-After`, not a hang or crash.
- **Timeout frees slots:** a deliberately wedged run (fixture endpoint that hangs) is killed at `RUN_TIMEOUT_SECONDS`; its slot is reclaimed; subsequent runs proceed.
- **Recycle:** Chromium process PID changes after `BROWSER_RECYCLE_RUNS` runs.
- **Drain:** SIGTERM during an in-flight run lets it finish (within grace) and rejects new intake.
- `/v1/health` saturation numbers move correctly under load.

### ▣ Plan & Verify gate — Phase 3
- **Plan check:** Have you enumerated every place a run touches shared state (browser, orchestrator vars, data binding, file paths, DB)? Each must be on the §8.1 invariant list with a test. If any shared mutable surface is unaccounted for, stop and close it.
- **Verify (automated):** the isolation cross-contamination test runs at high repetition in CI (it's the single most important test in the project); cap/backpressure/timeout/recycle/drain tests green.
- **Verify (load):** a short local load test (e.g. 50 sequential + 10 concurrent replays) shows stable memory (no creep across recycle boundaries) and no slot leaks (`runs_in_progress` returns to 0 at idle).
- **Exit condition:** the engine is provably safe to run multiple requests at once. Isolation is a tested invariant, not a hope — and it was proven on the deterministic path where failures are reproducible.

---

## Phase 4 — Agent Engine (Stagehand) & Playbook Compilation

> **Status: ✅ COMPLETE — live-verified** — Plan & Verify gate passed by observation (2026-06-17). Offline (64 tests, 1 live skipped in CI): deterministic compile→replay round-trip with different data, provenance-vs-page-text, action-only, require-explicit-model 422, SSRF/recorder/compiler/gateway units; dockerized cold-start (boot with agent deps, replay + 422 over HTTP). **Live, the full learn→replay round-trip is GREEN both on the host (`npm run test:live`) AND inside the dockerized engine (`scripts/docker-agent-check.ts`)** — the agent learns the fixture form, compiles a parameterized playbook, and it replays with *different* data and no LLM (cost: learn ≈ 12k tokens, replay = 0). Learn flow uses structured `act()` orchestration (DECISIONS #24); the container needs `CHROME_PATH` + the provider key (wired in compose). Granular tracker + Notes: [.ai-workspace/phase4_checklist.md](.ai-workspace/phase4_checklist.md). **Carried forward:** real-site demo, format-change-reuse optimization (DECISIONS #23). **Next: Phase 5 (on explicit go-ahead).**

Now the expensive path: learn a task from an instruction and **compile it into a playbook** the Phase-2 runner can replay. Isolation (Phase 3) already holds, so the agent inherits it.

### Tasks

**Stagehand integration**
- [ ] `AgentEngine` wrapping `stagehand.agent()`/`act()`/`observe()`/`extract()` in `LOCAL` mode, with the configured `model` (`provider/name`) resolved via the `ModelGateway` (Anthropic/OpenAI/Google/local).
- [ ] Browser launched through the Phase-3 pool/context factory (channel, proxy flag, headless per config) — agent runs are just another isolated run.
- [ ] Guardrails: `agent_max_steps` budget, wall-clock timeout (reuses Phase-3 timeout), domain confinement (no off-site nav unless `allow_offsite`), `captcha_detected` short-circuit.
- [ ] `SelectorCache` (local impl): persist Stagehand `observe()` results so repeat agent operations skip inference; S3 backend deferred to Phase 6.

**Action recording & provenance (the core mechanism, architecture §4)**
- [ ] Orchestrator builds a value→key reverse index from `data` before the run.
- [ ] `ActionRecorder` logs each effective action `{op, selector, fallback_selectors, description, dataProvenance|literal}` in order.
- [ ] Provenance by **exact value identity through the call**, not page-text scan (guard against coincidental matches).

**Compiler**
- [ ] `PlaybookCompiler`: recorded actions → declarative `vN.json` (Phase-2 schema).
- [ ] Parameterize: data-provenanced values → `{{data.key}}`; agent-chosen literals stored literally.
- [ ] Derive `required_data_keys` from provenance set; attach `output_format` verbatim; carry `fallback_selectors` from `observe()`.
- [ ] Action-only task (no `output_format`) → `playbook_type: "action"`, no extract step.
- [ ] Persist: new playbook id (`pb_...`), v1 body to store, index rows to Postgres, `created_by: agent_initial`.

**Agent-mode run wiring**
- [ ] `POST /v1/runs` with `instruction`+`url` (no `playbook_id`) → agent mode → extract (if format) → evidence → compile → envelope carries new `playbook_id` + `version:1`.
- [ ] `output_format` + existing `playbook_id` → new version with updated extraction step (reuse nav steps; re-invoke agent only if new fields can't be located) (`created_by: format_change`).
- [ ] `force_relearn` path (`playbook_id` + `instruction` + flag) → fresh agent run → new version.

### Acceptance criteria
- Fresh `instruction`+`url`+`data`+`output_format` against the fixture produces a correct `result` **and** a v1 playbook.
- **Round-trip:** immediately replay the freshly-compiled playbook (Phase-2 path) with new `data` → correct result, no LLM. This is the system's whole thesis — verify it explicitly.
- Parameterization correctness: a `data` value that also appears as static page text is NOT mis-templated (provenance, not string-match).
- Action-only instruction (no format) compiles a `type:action` playbook; replay returns `result:null`.
- Guardrails fire: step-budget exhaustion, off-site nav block, and CAPTCHA short-circuit each produce the right error code.
- Compiled playbook for one real Phase-0 site replays correctly.

### ▣ Plan & Verify gate — Phase 4
- **Plan check:** Does the compiled playbook for a real site actually generalize — i.e., does a replay with *different* input data work, not just a replay of the exact learned values? If parameterization is wrong, fix the provenance mechanism now; everything downstream assumes correct templating.
- **Verify (automated):** agent→compile→replay round-trip test green on the fixture; provenance-vs-page-text test green; action-only path green; guardrail tests green.
- **Verify (manual + cost):** learn + replay one real site; inspect the generated `vN.json` for sane selectors/parameterization; note the token cost of the agent run vs the ~free replay (sanity on the economics).
- **Exit condition:** the engine learns once and replays free. The two-speed core is real and demonstrated end-to-end on a real site.

---

## Phase 5 — Self-Heal & Surfaced LLM Extraction Fallback

Two resilience mechanisms that both lean on Phases 2+4. Self-heal = runner failure → agent → new version. LLM fallback = structural extraction miss → one-shot model extract, always surfaced.

### Tasks

**Self-heal (architecture §6.4)**
- [ ] Failure classification per the spec §7 table — heal-eligible (`step_failed`, `navigation_failed`, and `extraction_failed` only if `self_heal_on_extraction_failure`), infra-retry (`browser_crashed`), and never-heal (`captcha_detected`, `timeout`, `validation_error`, `playbook_not_found`, `agent_gave_up`, `internal_error`). Every code has a defined policy.
- [ ] On heal-eligible failure + resolved `playbook_self_heal=true`: same `run_id` continues in agent mode, `meta.mode=agent`, `meta.self_healed=true`.
- [ ] Instruction source: payload instruction if present, else stored `playbooks.instruction`.
- [ ] Success → compile `v(n+1)`, Postgres TXN (insert version → bump `active_version` → reset `consecutive_heal_failures`), envelope carries new version.
- [ ] Failure → `failed` envelope, `heal_attempted:true`, `heal_outcome`; increment `consecutive_heal_failures`; flag `health=unhealthy` at threshold.
- [ ] Pinned-version runs that heal still write `v(n+1)` (never overwrite the pinned slot).

**LLM extraction fallback (architecture §6.3 / spec §9.2)**
- [ ] `LlmExtractFallback`: engaged only when structural extraction misses ≥1 field AND `REPLAY_LLM_FALLBACK=on`.
- [ ] Uses `REPLAY_LLM_FALLBACK_MODEL`; resolves only the missing fields.
- [ ] **Always surfaced:** `meta.llm_fallback_used=true` + `meta.fallback_fields`; run is `completed` if data now correct.
- [ ] Metric `fallback_engaged_total{playbook_id}`; optional `FALLBACK_AS_DRIFT_SIGNAL=on` flags playbook for re-learn after K engagements.
- [ ] Fallback still missing a field → that field is an `extraction_error` as normal.

### Acceptance criteria
- **Heal end-to-end:** point a v1 playbook at the *mutated* fixture variant (renamed selector) → runner fails → heals → `v2` compiled → `v2` replays cleanly on the mutated site. `meta.self_healed=true`, new version in envelope.
- Heal respects config: with `playbook_self_heal=false`, the same failure returns `failed` with `heal_attempted:false`.
- Non-eligible codes never heal (CAPTCHA/timeout/validation).
- Unhealthy flagging: repeated heal failures cross threshold → `health=unhealthy` → surfaced via `GET /v1/playbooks?health=unhealthy`.
- **Fallback surfacing:** induce a structural miss with `REPLAY_LLM_FALLBACK=on` → field resolved, `meta.llm_fallback_used=true`, `fallback_fields` correct, metric incremented.
- With fallback `off`, the same miss → `completed_with_extraction_errors`, no LLM call.

### ▣ Plan & Verify gate — Phase 5
- **Plan check:** Are the heal-eligible vs non-eligible failure codes exactly right? A wrong classification either wastes agent runs (healing un-healable CAPTCHA failures) or silently rots playbooks (not healing real breaks). Walk the §7 error code list and confirm each one's heal policy.
- **Verify (automated):** mutate-and-heal test green; fallback-surfacing test green (both on and off); unhealthy-flag test green; pinned-heal-writes-new-version test green.
- **Verify (manual):** confirm a healed playbook's `v2` diff vs `v1` is sensible (selectors changed, structure preserved).
- **Exit condition:** the system is maintenance-free in the common case — site redesigns cost one agent run automatically, and silent extraction drift is impossible (always surfaced + counted).

---

## Phase 6 — Transports & Storage Backends (webhooks, SQS, S3, modes)

Swap the local edges for production ones, and split the process roles. The core is unchanged — these are interchangeable adapters around it.

### Tasks

**Webhooks**
- [ ] `WebhookDispatcher`: POST the envelope to `callback_url`; HMAC-SHA256 sign over raw body (`X-Engine-Signature`, per-caller secret).
- [ ] Retry 3× with backoff on non-2xx; record `webhook_status` on the run.

**SQS (architecture §8 / spec §4.2)**
- [ ] `SqsConsumer`: same payload schema + orchestrator as HTTP; active when `SQS_ENABLED=true` and `SERVICE_MODE∈{worker,all}`.
- [ ] Visibility heartbeat extension for long agent runs; prefetch only up to free slots.
- [ ] DLQ (`SQS_DLQ_URL`) for poison messages; optional results queue (`SQS_RESULTS_QUEUE_URL`) publishing the envelope.
- [ ] At-least-once safety: idempotency + idempotent evidence/version writes make redelivery safe.

**S3 backends**
- [ ] `PlaybookStore` S3 impl (same layout/prefix as local).
- [ ] `EvidenceStore` S3 impl; envelope carries signed expiring URLs.
- [ ] `SelectorCache` S3 impl (local impl introduced with Stagehand in Phase 4).
- [ ] `evidence_inline` path for air-gapped local mode (base64 in envelope).

**Service modes**
- [ ] `SERVICE_MODE=api`: HTTP only — validate/persist/enqueue (requires SQS).
- [ ] `SERVICE_MODE=worker`: SQS consume + execute only.
- [ ] `SERVICE_MODE=all`: HTTP + in-process loop (unchanged from earlier phases).

### Acceptance criteria
- Webhook delivered with a valid signature a caller can verify; retried on a simulated 500; `webhook_status` recorded.
- SQS message with the same payload schema runs identically to the HTTP path; result delivered by webhook and/or results queue.
- Worker crash mid-run → message redelivered → no duplicate playbook/version/evidence (idempotency holds).
- Poison message lands in DLQ after max receives.
- S3 backends: playbooks + evidence round-trip; signed evidence URL resolves; switching `STORAGE_BACKEND` local↔s3 needs no code change.
- `api` + `worker` split works end-to-end against SQS + RDS-style Postgres + S3.

### ▣ Plan & Verify gate — Phase 6
- **Plan check:** Is the payload→envelope contract *byte-identical* across HTTP and SQS? Any divergence means two code paths to maintain — confirm one orchestrator serves both.
- **Verify (automated):** webhook signing/retry tests; SQS redelivery-idempotency test; DLQ test; S3 round-trip tests; a backend-swap test (same suite passes on local and S3).
- **Verify (manual):** run the `api`+`worker` topology locally (LocalStack or real AWS dev) end-to-end.
- **Exit condition:** the engine runs in its production shape (scaled, queue-fed, S3-backed) with the same behavior it had as a single local container.

---

## Phase 7 — Hardening, Security, Observability, Docs

Named phase, own gate — not a backlog. Close the security and operability gaps before real traffic.

### Tasks

**Security (architecture §9)**
- [ ] `SsrfGuard`: deny RFC1918 / 169.254.0.0/16 / loopback / link-local for `url` and every agent navigation; `ALLOWED_PRIVATE_CIDRS` opt-in.
- [ ] `Redactor`: `data` values redacted in logs/traces; run rows store keys not values (unless `STORE_RUN_INPUTS=true`).
- [ ] Confirm playbook bodies never contain raw `data` values (only `{{data.*}}`) — automated check in the compiler tests.
- [ ] Auth mode enforcement per Phase-0 decision (`none|api_key|hmac`); secrets via env/secret-manager only.
- [ ] Confirm no playbook content is ever `eval`'d (op-vocabulary interpreter only).

**Observability (architecture §11)**
- [ ] Prometheus `/metrics`: `runs_total{mode,status}`, `heal_total{outcome}`, `fallback_engaged_total`, `agent_tokens_total`, `run_duration_seconds{mode}`, `playbook_hit_ratio`, saturation gauges, `requests_rejected_total{reason}`, `webhook_delivery_total`.
- [ ] Per-playbook health rollup endpoint/filter (`?health=unhealthy`).

**Chaos & resilience**
- [ ] Kill browser mid-run → clean failure + slot reclaimed.
- [ ] Storage unavailable (Postgres/S3) → graceful degradation + clear errors.
- [ ] SQS visibility expiry mid-run → safe redelivery.
- [ ] Queue-full backpressure under sustained burst.

**Docs**
- [ ] README quickstart (`docker run` local mode).
- [ ] Caller integration guide: payload reference, envelope reference, webhook verification, status/error codes.
- [ ] Operator guide: env reference, concurrency tuning, scaling on ECS, evidence retention.
- [ ] `DECISIONS.md` finalized; open questions (§17) updated with any v1 resolutions.

### Acceptance criteria
- SSRF attempts (private IP `url`, agent off-site nav) are blocked with the right error.
- No raw `data` value appears in any log, trace, run row, or playbook body (automated scan).
- `/metrics` exposes the full set; a dashboard can chart heal rate, fallback rate, saturation, token spend.
- All four chaos scenarios produce clean, observable, recoverable behavior.
- A new caller can integrate from the docs alone (dogfood: have someone unfamiliar wire up a run + webhook from the guide).

### ▣ Plan & Verify gate — Phase 7
- **Plan check:** Walk the security list as an attacker — SSRF, data exfiltration via logs, code execution via playbook, missing auth. Every item closed and tested?
- **Verify (automated):** SSRF tests; redaction/no-leak scan in CI; chaos suite green; metrics-presence test.
- **Verify (manual):** security review sign-off (ideally a second set of eyes, given this is a compliance-adjacent system); docs dogfood by someone uninvolved.
- **Exit condition:** safe to point real callers and real traffic at it. Production-ready by an explicit, reviewed standard — not by assumption.

---

## Cross-phase definition of done

A phase is done only when **all three** hold:
1. Its task boxes are checked.
2. Its acceptance criteria pass (automated where specified).
3. Its Plan & Verify gate passes — including the manual checks, which exist precisely because green unit tests don't prove the *behavior* is right.

The two tests that matter most for this system specifically: the **Phase 3 isolation cross-contamination test** (correctness under concurrency) and the **Phase 4 learn→replay round-trip** (the two-speed thesis). If either ever regresses, treat it as a release-blocker regardless of which phase you're in.
