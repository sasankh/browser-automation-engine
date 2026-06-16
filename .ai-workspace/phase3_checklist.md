# Phase 3 — Concurrency Core & Request Isolation — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase3_plan.md](./phase3_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [ ] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full.
- [ ] Re-read [phase3_plan.md](./phase3_plan.md) and this checklist end to end.
- [ ] Re-read the referenced master sections: ARCHITECTURE.md §8.1 (isolation invariants), §8.2 (capacity limits).
- [ ] Confirm the **Phase 2 Plan & Verify gate actually passed** — don't trust the checkbox; spot-check that Phase 2's exit condition holds against the code as built (EXECUTION_STANDARDS §7).
- [ ] Reconcile the plan against the codebase **as actually built** — note any drift from earlier-phase assumptions.
- [ ] Verify library/API choices are still current (Stagehand, Playwright, Fastify, Anthropic SDK, pg, Zod) — pin versions in the plan's Notes.
- [ ] Surface every open question / ambiguity / trade-off to the user. Contract-affecting ambiguity is a STOP-and-ask.
- [ ] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. Only then execute.

---


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
- [ ] Commit as `Phase 3: <summary>`.
- [ ] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7).

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

- Pinned versions:
- Deviations from plan (+ why):
- Benign warnings observed:
- Open items carried forward:
