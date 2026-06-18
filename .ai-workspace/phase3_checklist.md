# Phase 3 — Concurrency Core & Request Isolation — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase3_plan.md](./phase3_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [x] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full.
- [x] Re-read [phase3_plan.md](./phase3_plan.md) and this checklist end to end.
- [x] Re-read the referenced master sections: ARCHITECTURE.md §8.1 (isolation invariants), §8.2 (capacity limits).
- [x] Confirm the **Phase 2 Plan & Verify gate actually passed** — 21 tests green, dockerized cold-start replay, live real-site extraction; verified.
- [x] Reconcile the plan against the codebase **as actually built** — `browser.ts` already does context-per-run + shared Chromium process; Phase 3 formalizes into `BrowserPool`, **refactors the runner to take a `Page`** (so the wall-clock timeout can tear down a wedged context externally), and adds the semaphore/queue/timeout/recycle. The other four §8.1 invariants already hold.
- [x] Verify library/API choices are still current — playwright 1.61.0, **p-queue ^9.3.0** added; see Notes.
- [x] Surface every open question / ambiguity / trade-off to the user — 3 surfaced + answered (p-queue, 429 transport-rejection, heavy isolation test).
- [x] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. ✓ go-ahead received.

---


Make the engine safe under simultaneous load **before** the agent exists, so isolation is proven on the fully-controllable deterministic path. This is the phase that protects production.

### Tasks

**Isolation invariants (architecture §8.1)**
- [x] One Playwright `BrowserContext` per run, created at start, closed at end. Audit: no code path reuses a `Page`/`BrowserContext`/Stagehand instance across runs. — `BrowserPool.acquire()` does `newContext()`+`newPage()` per run; `release()` closes the context (`pool.ts`). Only the `Browser` (process) is held in a `Slot`.
- [x] `BrowserPool`: shares a Chromium **process** across contexts; never a context. — `Slot.browser` reused; context created per `acquire`. Keyed by `headless` (DECISIONS #19).
- [x] Per-run state object threaded explicitly through the orchestrator; static-analysis/lint rule or review check for module-level mutable run state. — `grep -rE '^(let|var) ' src/` → none; run ctx (`runId`/`page`/`data`/config) threaded as args through `Lifecycle.execute` → `runner.run`.
- [x] Per-run data binding + provenance index built and discarded per run (no shared "current data"). — `bindTemplate(value, data)` resolves against the run's own `data` arg; no shared structure (provenance reverse-index is Phase 4 agent path).
- [x] Keyed writes verified: `evidence/{run_id}/`, `(playbook_id, version)` — grep for any shared/`latest.*` paths. — evidence keyed by `runId`; bodies at `playbooks/{id}/v{n}.json`; `grep -ni latest src/` → no shared/`latest.*` paths.

**Capacity limits (architecture §8.2, three knobs)**
- [x] `MAX_CONCURRENT_RUNS` semaphore gating context acquisition. — `p-queue` `concurrency`; cap test: burst of 10 @ cap 2 → `runs_in_progress` ceiling held at 2.
- [x] `MAX_QUEUE_DEPTH` in-process bounded waiting room; overflow → `429` + `Retry-After`. — synchronous `tryReserve()`; backpressure test: cap 2 + queue 3, 6 simultaneous → exactly one 429 with `Retry-After` + `retry_after_seconds`.
- [x] `RUN_TIMEOUT_SECONDS` hard wall-clock per run → kill, tear down context, free slot, `timeout` error. — `Lifecycle.execute` races work vs timer that calls `ctx.release()`; timeout test: `/hang` @ `run_timeout_seconds=2` → `failed`/`meta.error.code=timeout`, next run on the freed single slot completes.
- [x] `MAX_RUN_TIMEOUT_SECONDS` ceiling on payload-supplied `run_timeout_seconds`. — `Math.min(runTimeout, maxRunTimeoutSeconds)` in `config-resolver.ts`; existing unit test `config-resolver.test.ts` "caps run_timeout_seconds at maxRunTimeoutSeconds".
- [x] `BROWSER_RECYCLE_RUNS`: recycle a Chromium process after N runs. — recycle test: `BROWSER_RECYCLE_RUNS=3`, `generation` 1 → 2 after the 4th acquire (recycle fires once contexts drained, DECISIONS #19).

**Lifecycle & health**
- [x] In-process job loop (`SERVICE_MODE=all`) pulling from the bounded queue, respecting the semaphore. — the `p-queue` is the loop; `Lifecycle.execute` enqueues each run and the semaphore bounds it.
- [x] Startup memory sanity check: warn if `MAX_CONCURRENT_RUNS × ~2GB` > detectable container memory. — `checkMemoryBudget()` reads cgroup v2/v1 then `os.totalmem()`; called in `index.ts` boot.
- [x] `/v1/health` reports live `runs_in_progress`, `queue_depth`, `max_concurrent_runs`. — `health.ts` emits `lifecycle.saturation()`; observed live during the cap/load tests and the dockerized gate.
- [x] Graceful drain on SIGTERM: stop intake, let in-flight runs finish within grace window, then exit. — `index.ts` SIGTERM/SIGINT → `lifecycle.drain(grace)`; drain test: in-flight run finishes, new intake → 503, health `status:draining`.

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
- [x] Re-read this checklist top to bottom; confirm **every task box above is genuinely checked by observation**, not assumption. Un-check anything you can't personally confirm right now. — every task box above carries its observed evidence.
- [x] Re-read the phase plan and the referenced `PROJECT_SPEC.md` / `ARCHITECTURE.md` sections; confirm what was built matches what they specify. Record any as-built drift in Notes and sync the master docs. — ARCHITECTURE §8.1–§8.5 match as-built; added a §8.5 line on the `generation`/PID-proxy + per-headless keying (DECISIONS #19). No contract drift.
- [x] `npx tsc --noEmit` is clean — zero errors, no new warnings introduced.
- [x] Full test suite green (unit + this phase's integration tests). — `vitest run`: **5 files, 27 tests passed** (21 prior + 6 Phase 3). `eslint .` clean.
- [x] **Cold start:** `docker compose down && docker compose up --build` (or fresh process start), then re-run the phase's key acceptance scenarios against the cold stack — not a warm dev server. Hot-reload state hides persistence and startup bugs. — `docker compose down -v && up --build`; fresh DB (migrations 0001+0002 applied on boot); load gate (`scripts/phase3-load.ts`, real HTTP) **2×60 runs, 0 contamination, saturation→0**, no level≥40 logs.

### Bug sweep
- [x] Walk each acceptance criterion and the plan's **edge cases / risks** list; actively try to break each one (bad input, missing field, repeat request, concurrent request where relevant). Log every defect found. — found 1 test-side defect (asserted `error` at envelope top-level; it lives at `meta.error`); no engine defects. Backpressure determinism, timeout slot-reclaim, recycle boundary, drain-503 all exercised.
- [x] Fix every defect found, or record it explicitly in Notes as a known issue with a reason it's deferred (deferring a correctness bug needs a user OK). — fixed the test assertion to read `meta.error.code`.
- [x] Re-run the affected scenarios after each fix; confirm no regression elsewhere. — full suite re-run green after the fix.
- [x] Confirm the contract is intact: payload in, `{meta, result}` out, statuses and error codes exactly per spec §5–§7. Contract drift is a STOP-and-ask, not a silent change. — envelope/status/`meta.error` unchanged; 429 is a transport rejection (no §7 code, DECISIONS #18).

### Standing regression gates (must stay green once their phase has landed)
- [x] Phase 3 isolation cross-contamination test (if Phase 3 has landed). — green @ 600 runs in vitest + 120 over real HTTP in the cold gate.
- [ ] Phase 4 learn→replay round-trip (if Phase 4 has landed). — N/A (Phase 4 not started).

### Sign-off
- [x] Notes section below is filled (versions, deviations, warnings, carried-forward items) — an empty Notes is a red flag.
- [x] `DECISIONS.md` updated for any user-confirmed decision made this phase (same commit). — #17–#20.
- [x] `PROJECT_CHECKLIST.md` status reflects reality (phase complete, next phase, blockers).
- [x] Commit as `Phase 3: <summary>`. — `Phase 3: concurrency core & request isolation`.
- [x] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7). — stopped; awaiting explicit Phase 4 go-ahead.

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

- **Pinned versions:** added `p-queue@^9.3.0` (ESM-only, fits the project's `type: module`); `playwright@^1.61.0` (lockstep with the `mcr.microsoft.com/playwright:v1.61.0-noble` image, which bundles Node 24.16). No other dep changes.
- **Deviations from plan (+ why):**
  - **Runner refactored to take a `Page`, not own its context** — the wall-clock timeout must tear a wedged context down *externally*, so the `Lifecycle`/`BrowserPool` own context lifecycle and the runner is handed a ready `page` (matches the kickoff §0 note). Replay test + real-site script updated to the new shape.
  - **Recycle verified via a `generation` counter, not OS PID** — Playwright doesn't expose the Chromium PID (DECISIONS #19). Acceptance "PID changes" is met as "generation increments."
  - **Isolation token flows through a form `fill`→`click`, not a templated `goto` URL** — `goto` does not bind `{{data.*}}` (only `fill`/`select` values do), by design for the deterministic runner; the fixture's `/iso/set` is a form that posts the token to `/iso/apply` (cookie + localStorage), exactly how a compiled playbook parameterizes input. No interpreter change.
  - **429 backpressure is a transport rejection** (DECISIONS #18) — no run row, no new §7 code.
- **Benign warnings observed:** none. `tsc`, `eslint`, and engine logs (level≥40) all clean across the cold-start load.
- **Memory (cold gate, `BROWSER_RECYCLE_RUNS=10`):** engine RSS 226 MiB idle → 397 MiB after 60 runs → 449 MiB after 120 — sub-linear and tapering (+171 then +52), i.e. warm-up to steady state, not a per-run leak across the ~12 recycle boundaries. Saturation returned to `{0,0}` at idle both batches (no slot leak).
- **Open items carried forward:** (a) `SERVICE_MODE` `api`/`worker` split + SQS transport is Phase 6 — Phase 3 governs the `all`-mode in-process loop only. (b) Global cross-container concurrency cap remains a v2 lever (ARCHITECTURE §8.2/§14). (c) Provider keys/agent path untouched (Phase 4).
