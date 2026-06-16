# Phase 2 — Playbook Runner (deterministic, no LLM) — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase2_plan.md](./phase2_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [ ] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full.
- [ ] Re-read [phase2_plan.md](./phase2_plan.md) and this checklist end to end.
- [ ] Re-read the referenced master sections: PROJECT_SPEC.md §8 · ARCHITECTURE.md §8.1 (paths), §5.
- [ ] Confirm the **Phase 1 Plan & Verify gate actually passed** — don't trust the checkbox; spot-check that Phase 1's exit condition holds against the code as built (EXECUTION_STANDARDS §7).
- [ ] Reconcile the plan against the codebase **as actually built** — note any drift from earlier-phase assumptions.
- [ ] Verify library/API choices are still current (Stagehand, Playwright, Fastify, Anthropic SDK, pg, Zod) — pin versions in the plan's Notes.
- [ ] Surface every open question / ambiguity / trade-off to the user. Contract-affecting ambiguity is a STOP-and-ask.
- [ ] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. Only then execute.

---


The cheap path. Execute a **declarative playbook** against a site with plain Playwright. Playbooks are hand-authored fixtures this phase (the agent that writes them comes in Phase 4) — this isolates the interpreter from the compiler.

### Tasks

**Fixture site**
- [ ] Bundled express fixture website in `test/fixtures/site`: a lookup form (text inputs + submit) → results page with extractable fields; an "action only" form (submit, no results); a deliberately mutated variant (selector renamed) for later heal tests.
- [ ] Compose profile or script to serve the fixture for integration tests (offline).

**Step interpreter**
- [ ] Declarative version-file schema (architecture §8.2): `steps[]`, `assertions[]`, `output_format`, `required_data_keys`, `engine_min_version`.
- [ ] Implement op vocabulary: `goto`, `click`, `fill`, `select`, `check`, `press`, `wait_for`, `wait_ms`, `scroll`, `extract`, `screenshot`.
- [ ] Per step: primary selector → `fallback_selectors` → `step_failed` with step index + message.
- [ ] `{{data.*}}` template binding against **this run's** data only.
- [ ] `assertions` evaluation (e.g., `url_matches` after a step).

**Structural extraction**
- [ ] `StructuralExtractor`: pull `output_format` fields from DOM using stored scope/field selectors; per-field success/failure.
- [ ] Missing fields → `extraction_errors` + status `completed_with_extraction_errors` (no guessing). (LLM fallback is Phase 5.)

**Playbook store (local) + versioning**
- [ ] `PlaybookStore` local FS impl: `playbooks/{id}/meta.json` + `vN.json` (architecture §8.1).
- [ ] Postgres `playbooks` + `playbook_versions` index rows kept in sync with bodies; `body_uri` pointer.
- [ ] `GET /v1/playbooks`, `GET /v1/playbooks/{id}` (contract: required keys, format, versions, active_version), `GET /v1/playbooks/{id}/versions/{v}`.
- [ ] `POST /v1/playbooks/{id}/activate` (pointer move / rollback) as a single Postgres transaction.
- [ ] `DELETE /v1/playbooks/{id}` soft-delete (tombstone; versions retained).
- [ ] Pinned replay: `playbook_version` in payload runs that exact version, never moves pointer.

**Replay wiring**
- [ ] `POST /v1/runs` with `playbook_id` → load active (or pinned) version → validate data vs `required_data_keys` (fail-fast `422` if missing) → run interpreter → extract → evidence → envelope.

**Evidence (local)**
- [ ] `EvidenceStore` local impl: screenshot + serialized HTML under `evidence/{run_id}/`; envelope carries engine-served paths; `GET /v1/runs/{id}/evidence`.

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
- [ ] Commit as `Phase 2: <summary>`.
- [ ] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7).

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

- Pinned versions:
- Deviations from plan (+ why):
- Benign warnings observed:
- Open items carried forward:
