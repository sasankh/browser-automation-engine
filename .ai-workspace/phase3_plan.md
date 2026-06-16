# Phase 3 — Concurrency Core & Request Isolation — Plan

> Status: **DRAFT**. Companion: [phase3_checklist.md](./phase3_checklist.md). Master refs: `ARCHITECTURE.md` §8.1 (isolation invariants), §8.2 (capacity limits).

## Goal

Make the engine safe under simultaneous load **before the agent exists**, so isolation is proven on the fully-controllable deterministic path where failures are reproducible. This is the phase that protects production — debugging a cross-request leak is far harder once an LLM is in the loop.

## Design decisions

- **Isolation is structural, not configurable.** It must hold at any concurrency value. The five invariants (ARCHITECTURE §8.1): one `BrowserContext` per run; no shared mutable run state; per-run data binding; keyed writes; Postgres pooled + transactional pointer. These are enforced in code, not toggled.
- **Three distinct limits, not one** (ARCHITECTURE §8.2): `MAX_CONCURRENT_RUNS` (resource gate), `MAX_QUEUE_DEPTH` (backpressure → `429`), `RUN_TIMEOUT_SECONDS` (frees a wedged slot). Conflating them is the failure mode this phase prevents.
- **Chromium process shared, context never.** The pool reuses processes for startup cost; each run gets a fresh context. The forbidden optimization (reuse a `Page`/context across runs) is called out in EXECUTION_STANDARDS §3 as an automatic review failure.
- **Per-container, not global.** No global limiter in v1 (ARCHITECTURE §14 lists it as a v2 lever).

## File-by-file (indicative)

- `src/browser/pool.ts` — Chromium process management, context-per-run, recycle after `BROWSER_RECYCLE_RUNS`.
- `src/browser/context-factory.ts` — build a context per resolved config (channel, headless; proxy stub for Phase 6).
- `src/orchestrator/lifecycle.ts` — semaphore (`MAX_CONCURRENT_RUNS`), bounded queue (`MAX_QUEUE_DEPTH` → `429`+`Retry-After`), per-run timeout enforcement, graceful drain on SIGTERM.
- `src/transport/routes/health.ts` — extend to live `runs_in_progress` / `queue_depth` / `max_concurrent_runs`.
- Startup memory sanity check (warn if `MAX_CONCURRENT_RUNS × ~2GB` > container memory).

## The critical test

**Isolation cross-contamination test** — N concurrent replays each set a distinct cookie/localStorage value on the fixture and read it back; every run sees only its own value, across many repetitions. This is the single most important test in the project and a permanent release-blocker (EXECUTION_STANDARDS §5). Build the fixture endpoints to support it.

## Edge cases

- Burst beyond `MAX_CONCURRENT_RUNS` → exactly the cap run; the rest queue.
- Queue full (`MAX_QUEUE_DEPTH`) → `429` + `Retry-After`, never a hang/crash.
- Wedged run (fixture hang endpoint) → killed at `RUN_TIMEOUT_SECONDS`, slot reclaimed, `timeout` error.
- SIGTERM mid-run → in-flight finishes within grace, new intake rejected.
- Recycle boundary → Chromium PID changes after N runs; memory stable across the boundary.

## Risks

- **Hidden shared state.** The plan-check requires enumerating *every* place a run touches shared state (browser, orchestrator vars, data binding, file paths, DB) and confirming each is on the §8.1 invariant list with a test. Any unaccounted surface is a stop-and-close.
- **Semaphore/queue races** — test under real bursts, never single-request assertions (EXECUTION_STANDARDS §5).

## Exit

The engine is provably safe to run many requests at once: the cross-contamination test passes at high repetition in CI; cap/backpressure/timeout/recycle/drain all verified; a short load test shows stable memory and no slot leaks (`runs_in_progress` returns to 0 at idle).
