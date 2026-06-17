# Phase 1 — Skeleton (API, config, Postgres, envelope, Docker) — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase1_plan.md](./phase1_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [ ] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full.
- [ ] Re-read [phase1_plan.md](./phase1_plan.md) and this checklist end to end.
- [ ] Re-read the referenced master sections: PROJECT_SPEC.md §4–§7, §10, §12 · ARCHITECTURE.md §5.1, §10.
- [ ] Confirm the **Phase 0 Plan & Verify gate actually passed** — don't trust the checkbox; spot-check that Phase 0's exit condition holds against the code as built (EXECUTION_STANDARDS §7).
- [ ] Reconcile the plan against the codebase **as actually built** — note any drift from earlier-phase assumptions.
- [ ] Verify library/API choices are still current (Stagehand, Playwright, Fastify, Anthropic SDK, pg, Zod) — pin versions in the plan's Notes.
- [ ] Surface every open question / ambiguity / trade-off to the user. Contract-affecting ambiguity is a STOP-and-ask.
- [ ] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. Only then execute.

---


A running service that accepts a run, persists it, and returns an envelope — with **no browser yet**. This proves the contract and the plumbing.

### Tasks

**Project setup**
- [ ] TS + Node 24 (latest LTS) project; strict tsconfig; ESLint/Prettier; vitest or jest.
- [ ] Fastify server; `PORT`; structured JSON logger (pino) with `run_id` scoping.
- [ ] Dockerfile `FROM mcr.microsoft.com/playwright:<pinned>` (browser deps present even though unused this phase); `tini` as PID 1.
- [ ] `docker-compose.yml`: engine + Postgres; `DATABASE_URL` wired; `-v ./data:/data`.

**Config**
- [ ] `ConfigResolver`: pure per-key merge **payload.config > env > builtin default** (spec §10).
- [ ] Implement the full env surface from spec §10 (storage, SQS placeholders, concurrency limits as values even if not yet enforced, fallback flags).
- [ ] `effective_config` frozen onto each run and echoed in `meta`.
- [ ] Enforce env-only keys: payload attempting to set a capacity/destination key is ignored (and logged at debug).

**Payload & envelope**
- [ ] Zod schema for the full payload (spec §5): `instruction`, `url`, `output_format`, `playbook_id`, `playbook_version`, `data`, `config`, `callback_url`, `idempotency_key`.
- [ ] Resolution precondition validation: reject when neither `playbook_id` nor (`instruction`+`url`) present → `validation_error`.
- [ ] Envelope builder (`{ meta, result }`, spec §6) with all `meta` fields; `result` is caller-shape-or-null.
- [ ] Status vocabulary + error model types (spec §7).

**Persistence (Postgres)**
- [ ] Migrations for `playbooks`, `playbook_versions`, `runs`, `idempotency_keys` (architecture §5.1).
- [ ] `RunStore`: create/update run rows; status transitions.
- [ ] `IdempotencyGuard`: `(caller, idempotency_key)` unique; repeat returns existing run's envelope.

**Endpoints**
- [ ] `POST /v1/runs` → validate, persist `queued`, return `202 {meta:{run_id,status}}`. (Execution stubbed: immediately marks `failed` with `not_implemented` OR echoes a canned envelope — pick one and note it.)
- [ ] `GET /v1/runs/{run_id}` → current envelope from `RunStore`.
- [ ] `GET /v1/health` → liveness + DB reachability (saturation fields return zeros this phase).

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
- [ ] Re-read this checklist top to bottom; confirm **every task box above is genuinely checked by observation**, not assumption. Un-check anything you can't personally confirm right now.
- [ ] Re-read the phase plan and the referenced `PROJECT_SPEC.md` / `ARCHITECTURE.md` sections; confirm what was built matches what they specify. Record any as-built drift in Notes and sync the master docs.
- [ ] `npx tsc --noEmit` is clean — zero errors, no new warnings introduced.
- [ ] Full test suite green (unit + this phase's integration tests).
- [ ] **Cold start:** `docker compose down && docker compose up --build` (or fresh process start), then re-run the phase's key acceptance scenarios against the cold stack — not a warm dev server. Hot-reload state hides persistence and startup bugs.

### Bug sweep
- [ ] Walk each acceptance criterion and the plan's **edge cases / risks** list; actively try to break each one (bad input, missing field, repeat request, concurrent request where relevant). Log every defect found.
- [ ] Fix every defect found, or record it explicitly in Notes as a known issue with a reason it's deferred (deferring a correctness bug needs a user OK).
- [ ] Re-run the affected scenarios after each fix; confirm no regression elsewhere.
- [ ] Confirm the contract is intact: payload in, `{meta, result}` out, statuses and error codes exactly per spec §5–§7. Contract drift is a STOP-and-ask, not a silent change.

### Standing regression gates (must stay green once their phase has landed)
- [ ] Phase 3 isolation cross-contamination test (if Phase 3 has landed).
- [ ] Phase 4 learn→replay round-trip (if Phase 4 has landed).

### Sign-off
- [ ] Notes section below is filled (versions, deviations, warnings, carried-forward items) — an empty Notes is a red flag.
- [ ] `DECISIONS.md` updated for any user-confirmed decision made this phase (same commit).
- [ ] `PROJECT_CHECKLIST.md` status reflects reality (phase complete, next phase, blockers).
- [ ] Commit as `Phase 1: <summary>`.
- [ ] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7).

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

- Pinned versions:
- Deviations from plan (+ why):
- Benign warnings observed:
- Open items carried forward:
