# Phase 1 — Skeleton (API, config, Postgres, envelope, Docker) — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase1_plan.md](./phase1_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [x] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full.
- [x] Re-read [phase1_plan.md](./phase1_plan.md) and this checklist end to end.
- [x] Re-read the referenced master sections: PROJECT_SPEC.md §4–§7, §10, §12 · ARCHITECTURE.md §5.1, §10.
- [x] Confirm the **Phase 0 Plan & Verify gate actually passed** — committed (`1611ce1`+`6c20331`), tree clean, decisions #6–#11 recorded.
- [x] Reconcile the plan against the codebase **as actually built** — no code yet (clean slate); no drift.
- [x] Verify library/API choices are still current — pinned in Phase 0 (Node 24, TS 6, Fastify 5, Zod 4, pino 10, pg 8, vitest 4, eslint 10, tsx 4); see Notes.
- [x] Surface every open question / ambiguity / trade-off to the user — 3 surfaced + answered (stub→internal_error, effective_config behavior-keys-only, CI deferred).
- [x] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. ✓ go-ahead received.

---


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
- [x] `POST /v1/runs` → validate, persist `queued`, return `202 {meta:{run_id,status}}`. (Execution stubbed: immediately marks `failed` with `not_implemented` OR echoes a canned envelope — pick one and note it.)
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

## ▣ Phase Review & Verification (mandatory — do before declaring the phase done)

Run this section literally, in order. A phase is **not done** until every box here is checked. Per EXECUTION_STANDARDS §1.6 and §5, green unit tests do not prove the behavior is right — re-verify by observation.

### Re-verification (cold)
- [x] Re-read this checklist top to bottom; confirm **every task box above is genuinely checked by observation**, not assumption. Un-check anything you can't personally confirm right now.
- [x] Re-read the phase plan and the referenced `PROJECT_SPEC.md` / `ARCHITECTURE.md` sections; confirm what was built matches what they specify. Record any as-built drift in Notes and sync the master docs.
- [x] `npx tsc --noEmit` is clean — zero errors, no new warnings introduced.
- [x] Full test suite green (unit + this phase's integration tests).
- [x] **Cold start:** `docker compose down && docker compose up --build` (or fresh process start), then re-run the phase's key acceptance scenarios against the cold stack — not a warm dev server. Hot-reload state hides persistence and startup bugs.

### Bug sweep
- [x] Walk each acceptance criterion and the plan's **edge cases / risks** list; actively try to break each one (bad input, missing field, repeat request, concurrent request where relevant). Log every defect found.
- [x] Fix every defect found, or record it explicitly in Notes as a known issue with a reason it's deferred (deferring a correctness bug needs a user OK).
- [x] Re-run the affected scenarios after each fix; confirm no regression elsewhere.
- [x] Confirm the contract is intact: payload in, `{meta, result}` out, statuses and error codes exactly per spec §5–§7. Contract drift is a STOP-and-ask, not a silent change.

### Standing regression gates (must stay green once their phase has landed)
- [ ] Phase 3 isolation cross-contamination test — N/A this phase (Phase 3 not landed).
- [ ] Phase 4 learn→replay round-trip — N/A this phase (Phase 4 not landed).

### Sign-off
- [x] Notes section below is filled (versions, deviations, warnings, carried-forward items) — an empty Notes is a red flag.
- [x] `DECISIONS.md` updated for any user-confirmed decision made this phase (same commit).
- [x] `PROJECT_CHECKLIST.md` status reflects reality (phase complete, next phase, blockers).
- [x] Commit as `Phase 1: <summary>`.
- [x] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7).

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

**Kickoff (2026-06-16):** §0 done — docs re-read this session; Phase 0 gate confirmed (committed, tree clean, decisions #6–#11); no code to reconcile; currency pinned in Phase 0; questions surfaced + answered; go-ahead received.

**User-confirmed decisions this phase:**
- Stub `POST /v1/runs` → `failed` + `error.code: internal_error` (NOT `not_implemented`; §7 set unchanged). → DECISIONS #12.
- `meta.effective_config` echoes resolved **behavior keys only** (no secrets/destinations/capacity). → DECISIONS #13.
- **CI deferred** — gate satisfied locally (tsc/tests/docker by hand); GitHub Actions added later with the GitHub admin.
- `caller` under `API_AUTH_MODE=none` = constant `"default"` (idempotency global-by-key for v1).
- `model` optional config key, no default; require-explicit→`validation_error` enforcement deferred to Phase 4.

**Tooling / deviations (record as built):**
- **Run via `tsx`** (ESM, `moduleResolution: Bundler`); `tsc --noEmit` for typecheck — no emit/build step this phase (reduces ESM `.js`-extension friction).
- **Migrations: lightweight custom SQL runner** (`migrations/NNNN_*.sql` applied via `src/persistence/migrate.ts`, tracked in `schema_migrations`) instead of `node-pg-migrate` — matches ARCHITECTURE §12 SQL-first "or similar" + the plan's explicit-SQL preference; fewer deps.
- `.env` via `dotenv` at entry (no-op if absent); Docker/compose supply env directly.

- Pinned versions: (lockfile at `npm install`) node 24 · typescript ^6.0.3 · fastify ^5.8.5 · zod ^4.4.3 · pino ^10.3.1 · pg ^8.21.0 · ulidx ^2.4.1 · dotenv ^17.4.2 · vitest ^4.1.9 · eslint ^10.5.0 · typescript-eslint ^8.61.1 · tsx ^4.22.4 · prettier ^3.8.4 · @types/node ^24 · @types/pg ^8.20.0
- Deviations from plan (+ why): tsx-run + custom SQL migrator (above).
- Benign warnings observed: npm "new minor version" notice (cosmetic); no tsc/eslint warnings.
- **Verification (cold start, observed):** `docker compose down -v && up --build` → migrations applied on a fresh DB, engine healthy. Acceptance all green — valid POST→`202`+row; idempotent repeat→same `run_id`; precondition + non-JSON→`validation_error` (no row); unknown route→`404`; GET envelope `failed`/`internal_error`, `effective_config` = behavior-keys-only with payload `headless:false` override + `model:null`. `tsc` clean · 16/16 unit tests · eslint clean.
- **Node reconciliation (resolves DECISIONS #10 open item):** the pinned Playwright image `v1.61.0-noble` bundles **Node v24.16.0** — the Node-24 target holds in the container; no change needed.
- **Defect found & fixed in bug sweep:** a non-JSON body leaked Fastify's raw `FST_ERR_CTP_INVALID_JSON_BODY`; added a Fastify error/not-found handler so malformed→`validation_error`, unexpected→`internal_error`, unknown route→`404` (EXECUTION_STANDARDS §3 error posture).
- Open items carried forward: CI workflow; GitHub admin (CODEOWNERS/branch protection); provider keys (Phase 4).
