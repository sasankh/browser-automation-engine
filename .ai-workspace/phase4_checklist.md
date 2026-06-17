# Phase 4 — Agent Engine (Stagehand) & Playbook Compilation — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase4_plan.md](./phase4_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [x] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full.
- [x] Re-read [phase4_plan.md](./phase4_plan.md) and this checklist end to end.
- [x] Re-read the referenced master sections: PROJECT_SPEC.md §9.1, §5.2 · ARCHITECTURE.md §4 (record→compile→parameterize), §3.4.
- [x] Confirm the **Phase 3 Plan & Verify gate actually passed** — don't trust the checkbox; spot-check that Phase 3's exit condition holds against the code as built (EXECUTION_STANDARDS §7). — verified this session: 27 tests green incl. isolation @600, dockerized cold-start load gate clean, no module-level run state.
- [x] Reconcile the plan against the codebase **as actually built** — note any drift from earlier-phase assumptions. — `CreatedBy` has `agent_initial`/`format_change`, `RunMode` has `agent`, `model`/`agent_max_steps` resolved, instruction path is the stub to replace. **Drift found:** the plan assumed the agent runs on the Phase-3 Playwright pool — impossible with Stagehand v3.5 (see below); resolved as DECISIONS #21.
- [x] Verify library/API choices are still current (Stagehand, Playwright, Fastify, Anthropic SDK, pg, Zod) — pin versions in the plan's Notes. — Stagehand `3.5.0` is npm `latest` (v3 CDP-native, Playwright optional peer); pinned in plan Kickoff notes. Others unchanged from Phase 3.
- [x] Surface every open question / ambiguity / trade-off to the user. Contract-affecting ambiguity is a STOP-and-ask. — 3 surfaced + answered: Stagehand integration (v3.5, Stagehand owns browser), agent test model (Anthropic Sonnet, env key, opt-in), real-site scope (fixture-now, defer).
- [x] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. Only then execute. — plan + checklist + DECISIONS #21–#22 updated; **awaiting explicit "start Phase 4" before any code.**

---


Now the expensive path: learn a task from an instruction and **compile it into a playbook** the Phase-2 runner can replay. Isolation (Phase 3) already holds, so the agent inherits it.

### Tasks

> Legend: [x] = built + verified by observation offline. [x]† = built + wired against the real Stagehand
> v3.5 API; its end-to-end *live* behavior is exercised by the opt-in `npm run test:live` (no key in CI).
> **As of 2026-06-17 the `†` live path is GREEN** — `test:live` passes the full learn→replay round-trip
> against a real Anthropic model (DECISIONS #24). [ ] DEFERRED = carried forward with a reason.

**Stagehand integration**
- [x]† `AgentEngine` wrapping `stagehand.agent()`/`act()`/`observe()`/`extract()` in `LOCAL` mode, model resolved via the `ModelGateway` (`src/model/`, require-explicit — DECISIONS #11). — `agent-engine.ts`; require-explicit 422 verified offline + over HTTP.
- [x]† Agent browser launched by **Stagehand v3.5 itself** in `env: LOCAL` (one instance per run = one isolated session) — NOT the Phase-3 pool (DECISIONS #21). Concurrency + wall-clock gated by `Lifecycle.executeAgent` (semaphore + `AbortSignal`); the pool remains the replay browser.
- [x]† Guardrails: `agent_max_steps` (→ `agent_gave_up`), wall-clock (`AbortSignal`→`timeout`), domain confinement (off-site→`navigation_failed`), `captcha_detected` short-circuit. — guardrail *logic* (`ssrf-guard`, error mapping) unit-tested; *firing during a live agent run* is opt-in.
- [x] `SelectorCache` (local impl): persist `observe()` results so repeat ops skip inference; S3 deferred to Phase 6. — `selector-cache.ts`.

**Action recording & provenance (the core mechanism, architecture §4)**
- [x] Orchestrator/engine builds a value→key reverse index from `data` before the run. — `ProvenanceIndex`, unit-tested.
- [x] `ActionRecorder` logs each effective action `{op, selector, fallback_selectors, description, dataProvenance|literal}` in order. — `recordActions` (history→RecordedAction), unit-tested.
- [x] Provenance by **exact value identity through the call**, not page-text scan. — unit-tested incl. the coincidental page-text guard + ambiguous-value refusal.

**Compiler**
- [x] `PlaybookCompiler`: recorded actions → declarative `vN.json` (validated against the Phase-2 schema). — `compiler.ts`, unit-tested.
- [x] Parameterize: data-provenanced values → `{{data.key}}`; agent-chosen literals stored literally. — unit-tested.
- [x] Derive `required_data_keys` from provenance set; attach `output_format` verbatim; carry `fallback_selectors`. — unit-tested.
- [x] Action-only task (no `output_format`) → `playbook_type: "action"`, no extract step. — unit + replay-tested.
- [x] Persist: new playbook id (`pb_...`), v1 body to store, index rows to Postgres, `created_by: agent_initial`. — wired; offline compile→replay seeds via `agent_initial`.

**Agent-mode run wiring**
- [x]† `POST /v1/runs` with `instruction`+`url` (no `playbook_id`) → agent → extract → evidence → compile → envelope carries new `playbook_id` + `version:1`. — wired; intake/compile/replay verified offline, full live path opt-in.
- [ ] DEFERRED `output_format` + existing `playbook_id` → new version reusing nav steps (re-invoke agent only if new fields can't be located) (`created_by: format_change`). — carried forward (DECISIONS #23): optimization over a full relearn; needs live iteration.
- [x]† `force_relearn` path (`playbook_id` + `instruction` + flag) → fresh agent run → new version (`addVersion`). — wired.

### Acceptance criteria
- Fresh `instruction`+`url`+`data`+`output_format` against the fixture produces a correct `result` **and** a v1 playbook.
- **Round-trip:** immediately replay the freshly-compiled playbook (Phase-2 path) with new `data` → correct result, no LLM. This is the system's whole thesis — verify it explicitly.
- Parameterization correctness: a `data` value that also appears as static page text is NOT mis-templated (provenance, not string-match).
- Action-only instruction (no format) compiles a `type:action` playbook; replay returns `result:null`.
- Guardrails fire: step-budget exhaustion, off-site nav block, and CAPTCHA short-circuit each produce the right error code.
- ~~Compiled playbook for one real Phase-0 site replays correctly.~~ **Deferred (DECISIONS #22)** — fixture proves the mechanism this phase; real-site learn+replay + token-cost note carried forward to run once a key/site is wired.

### ▣ Plan & Verify gate — Phase 4
- **Plan check:** Does the compiled playbook for a real site actually generalize — i.e., does a replay with *different* input data work, not just a replay of the exact learned values? If parameterization is wrong, fix the provenance mechanism now; everything downstream assumes correct templating.
- **Verify (automated):** agent→compile→replay round-trip test green on the fixture; provenance-vs-page-text test green; action-only path green; guardrail tests green.
- **Verify (manual + cost):** learn + replay one real site; inspect the generated `vN.json` for sane selectors/parameterization; note the token cost of the agent run vs the ~free replay (sanity on the economics).
- **Exit condition:** the engine learns once and replays free. The two-speed core is real and demonstrated end-to-end on a real site.

## ▣ Phase Review & Verification (mandatory — do before declaring the phase done)

Run this section literally, in order. A phase is **not done** until every box here is checked. Per EXECUTION_STANDARDS §1.6 and §5, green unit tests do not prove the behavior is right — re-verify by observation.

### Re-verification (cold)
- [x] Re-read this checklist top to bottom; every task box reflects observation (offline) or is marked `†` (built+typechecked, live-validated opt-in) / DEFERRED.
- [x] Re-read the phase plan + referenced `PROJECT_SPEC.md §9.1/§5.2` / `ARCHITECTURE.md §4/§3.4`; synced as-built drift — ARCHITECTURE §3.4 (AgentEngine=Stagehand-CDP, ModelGateway resolution-only), §12 (+`src/model/`, +`recorded-action.ts`), CLAUDE.md current-state, DECISIONS #23.
- [x] `npx tsc --noEmit` clean.
- [x] Full test suite green — **61 passed, 1 skipped** (the live test); `eslint .` clean. Phase 3 isolation regression still green.
- [x] **Cold start:** `docker compose down -v && up --build`; engine boots with the agent deps (Stagehand import OK, migrations applied); **compiled-playbook replay + require-explicit-model 422 verified over real HTTP**. (Live agent learn cold-start is opt-in — needs a key.)

### Bug sweep
- [x] Walked the acceptance criteria + edge cases on the offline-verifiable surface: require-explicit (no model / missing key → 422), provenance vs page-text, ambiguous values, action-only, malformed/private SSRF targets, unmappable agent op (surfaced, not dropped). Found 0 defects in the offline core.
- [x] Live-path edges (agent step-budget / off-site / captcha firing; history→record fidelity; extraction-selector observe) are **carried forward to live validation** — logic unit-tested, end-to-end needs a key. Recorded below, not silently passed.
- [x] Re-ran the full suite after the final wiring; green.
- [x] Contract intact: `{meta, result}`, statuses, §7 error codes unchanged. Agent failures map to existing codes (`agent_gave_up`/`captcha_detected`/`navigation_failed`/`extraction_failed`/`timeout`/`browser_crashed`); 429 unchanged. No new contract surface.

### Standing regression gates (must stay green once their phase has landed)
- [x] Phase 3 isolation cross-contamination test — green (in the full suite).
- [x] Phase 4 learn→replay round-trip — **GREEN, both halves**: deterministic compile→replay offline (CI-enforced), AND the **full live learn→replay** (`npm run test:live`, real Anthropic Sonnet) verified 2026-06-17 — the agent learns the fixture form, compiles a parameterized playbook, and it replays with *different* data and no LLM.

### Sign-off
- [x] Notes filled (versions, deviations, warnings, carried-forward).
- [x] `DECISIONS.md` updated (#21–#23, recorded at kickoff + gate).
- [x] `PROJECT_CHECKLIST.md` status reflects reality (Phase 4 fixture-complete, carried-forward listed, next Phase 5).
- [x] Commit as `Phase 4: <summary>`. — `Phase 4: agent engine (Stagehand v3.5) & playbook compilation`.
- [x] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7). — stopped; awaiting explicit Phase 5 go-ahead.

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

**Kickoff (2026-06-17) — pre-build:**
- **Pinned versions (to install at build):** `@browserbasehq/stagehand@^3.5.0` (npm `latest`; v3 CDP-native), Vercel AI SDK `ai` + `@ai-sdk/anthropic` (+ `@ai-sdk/openai`/`@ai-sdk/google`/`@ai-sdk/openai-compatible` defined-but-not-exercised). `playwright@^1.61.0` unchanged (replay path). Re-confirm with `npm view` before pinning.
- **Deviations from plan (+ why):** agent browser is **Stagehand-owned (CDP)**, not the Phase-3 Playwright pool — Stagehand v3.5 (latest stable) won't accept an external Page (issue #1392). User-confirmed (DECISIONS #21). Concurrency/timeout still via the Phase-3 `Lifecycle`.
- **Benign warnings observed:** —
- **Open items carried forward:** (a) real-site learn+replay demo + token-cost note (DECISIONS #22); (b) build-time check: does `agent()` expose a selector-level action stream for compilation, or orchestrate `observe()`→`act()` instead (record the choice); (c) `@ai-sdk/*` providers beyond Anthropic are wired but only Anthropic is exercised this phase.
- **Master-doc sync (do at gate):** ARCHITECTURE §3.4 (AgentEngine browser = Stagehand-CDP) + §8 (agent path browser mechanism) reconcile as-built; CLAUDE.md mentions "Stagehand driving the configured LLM provider" — confirm wording still holds.

**Build (2026-06-17) — as-built:**
- **Pinned:** `@browserbasehq/stagehand@3.5.0` (npm `latest`; bundles `ai`@5, `@anthropic-ai/sdk`, `openai`, `@google/genai` — so the agent path needs no separate `@ai-sdk/*` install; those land in the Phase-5 fallback). Stagehand peer-deps `playwright-core` — satisfied by our `playwright@^1.61.0`. zod peer `^4.2.0` — satisfied. No other new deps.
- **Stagehand v3.5 API used:** `new Stagehand({env:'LOCAL', model:{modelName, apiKey, baseURL?}, localBrowserLaunchOptions:{headless,args,executablePath?}, verbose:0, disablePino:true, logger, waitForCaptchaSolves:false})`; `init()`; page via `context.activePage()`; `agent().execute({instruction, maxSteps, signal})` (tool-based, provider-agnostic — NOT CUA-only); `extract(instruction, zodSchema)`; `observe(instruction)→Action[]` (selectors for the extract step); `history` (navigate/act entries → recorded stream); `close({force:true})`.
- **New modules:** `src/model/model-gateway.ts`, `src/execution/agent/{recorded-action,provenance,action-recorder,compiler,agent-engine}.ts`, `src/browser/ssrf-guard.ts`, `src/persistence/cache/selector-cache.ts`; `Lifecycle.executeAgent` (agent gating without a pool context); `RunStore.finishRun` gained `playbookId`/`playbookVersion` (COALESCE — replay runs untouched). No migration (existing `runs` columns).
- **Deviations from plan:** (1) recording reconstructed from `stagehand.history` (act/navigate entries carry `Action.selector/method/arguments`) rather than a bespoke recorder hook — this is the "does `agent()` expose a selector stream" kickoff question, resolved via `history`; **needs live confirmation** that the autonomous agent populates `history` with per-act selectors (if not, switch the learn loop to `observe()`→`act()`). (2) extraction field→selector derived by `observe("the element showing <field>")` per field (cached) — live-tunable. (3) `format_change`-reuse deferred (DECISIONS #23).
- **Benign warnings:** `npm install` emitted one `ERESOLVE overriding peer dependency` (browser-driver peer) + a `node-domexception` deprecation — both transitive to Stagehand, non-blocking; install succeeded, tsc/eslint/tests clean.
- **Carried forward:** (a) **live learn-path validation + tuning** via `test:live` with `ANTHROPIC_API_KEY` (the autonomous-agent history fidelity + extraction-selector observe are the two spots most likely to need iteration); (b) real-site demo + token-cost note (DECISIONS #22); (c) `format_change`-reuse optimization (DECISIONS #23); (d) guardrails firing end-to-end against a live agent.
- **Cost note (economics, plan §risks):** measured live — learn ≈ **11,490 input + 590 output tokens** (Sonnet, structured `act()` flow), replay = **0 LLM**. (The earlier autonomous-`agent()` attempt cost ~71k input for a worse result — another reason structured `act()` won.)

**Live validation (2026-06-17) — `npm run test:live` against a real Anthropic key:**
- **GREEN.** Full learn→replay round-trip passes: the agent learns the fixture lookup form, compiles a parameterized playbook (`fill {{data.license_number}}` / `{{data.last_name}}` → submit → `wait_for` → extract), and it replays with *different* data (`Z999000`/`Okonkwo`) deterministically, no LLM. Run via `node --env-file=.env node_modules/vitest/vitest.mjs run test/integration/agent-live.test.ts` (vitest doesn't auto-load `.env`).
- **Three live fixes** (see DECISIONS #24): (1) Stagehand abort-signal needs `experimental:true`+`disableAPI:true`; (2) Anthropic base URL normalized to `/v1` (a conventional root `ANTHROPIC_BASE_URL` in the shell 404'd `@ai-sdk/anthropic`); (3) **learn flow switched from autonomous `agent()` to structured `act()`** — the autonomous agent's `history` records fills as value-less clicks (empty `required_data_keys`, no `{{data.*}}`), so it can't compile a replayable playbook; structured `act()` returns the operated selector and the data key is known directly.
- **As-built deviation:** `provenance.ts` (value-identity reverse index) and `action-recorder.ts` (history→action mapping) are **retained** (match the spec §12 module layout; encode the mechanisms for a future autonomous/history-recording path) but the structured `act()` flow doesn't wire them — it sets `dataProvenance` directly from the per-field `act` call. Recorded here, not silently.
- **Resolved kickoff risk:** "does `agent()` expose a selector-level stream?" — answered NO; structured `act()` is the chosen path.
