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

**Stagehand integration**
- [ ] `AgentEngine` wrapping `stagehand.agent()`/`act()`/`observe()`/`extract()` in `LOCAL` mode, with the configured `model` (`provider/name`) resolved via the `ModelGateway` (Anthropic/OpenAI/Google/local). *(Kickoff adds the `ModelGateway` build task + the require-explicit-`model` validation — DECISIONS #11.)*
- [ ] Agent browser launched by **Stagehand v3.5 itself** in `env: LOCAL` (one instance per run = one isolated session; `localBrowserLaunchOptions` carries headless/proxy/args + the Docker Chromium `executablePath`/`channel`) — NOT the Phase-3 Playwright pool (DECISIONS #21). Concurrency + wall-clock still gated by the Phase-3 `Lifecycle`; the pool remains the replay browser.
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
- ~~Compiled playbook for one real Phase-0 site replays correctly.~~ **Deferred (DECISIONS #22)** — fixture proves the mechanism this phase; real-site learn+replay + token-cost note carried forward to run once a key/site is wired.

### ▣ Plan & Verify gate — Phase 4
- **Plan check:** Does the compiled playbook for a real site actually generalize — i.e., does a replay with *different* input data work, not just a replay of the exact learned values? If parameterization is wrong, fix the provenance mechanism now; everything downstream assumes correct templating.
- **Verify (automated):** agent→compile→replay round-trip test green on the fixture; provenance-vs-page-text test green; action-only path green; guardrail tests green.
- **Verify (manual + cost):** learn + replay one real site; inspect the generated `vN.json` for sane selectors/parameterization; note the token cost of the agent run vs the ~free replay (sanity on the economics).
- **Exit condition:** the engine learns once and replays free. The two-speed core is real and demonstrated end-to-end on a real site.

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
- [ ] Commit as `Phase 4: <summary>`.
- [ ] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7).

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

**Kickoff (2026-06-17) — pre-build:**
- **Pinned versions (to install at build):** `@browserbasehq/stagehand@^3.5.0` (npm `latest`; v3 CDP-native), Vercel AI SDK `ai` + `@ai-sdk/anthropic` (+ `@ai-sdk/openai`/`@ai-sdk/google`/`@ai-sdk/openai-compatible` defined-but-not-exercised). `playwright@^1.61.0` unchanged (replay path). Re-confirm with `npm view` before pinning.
- **Deviations from plan (+ why):** agent browser is **Stagehand-owned (CDP)**, not the Phase-3 Playwright pool — Stagehand v3.5 (latest stable) won't accept an external Page (issue #1392). User-confirmed (DECISIONS #21). Concurrency/timeout still via the Phase-3 `Lifecycle`.
- **Benign warnings observed:** —
- **Open items carried forward:** (a) real-site learn+replay demo + token-cost note (DECISIONS #22); (b) build-time check: does `agent()` expose a selector-level action stream for compilation, or orchestrate `observe()`→`act()` instead (record the choice); (c) `@ai-sdk/*` providers beyond Anthropic are wired but only Anthropic is exercised this phase.
- **Master-doc sync (do at gate):** ARCHITECTURE §3.4 (AgentEngine browser = Stagehand-CDP) + §8 (agent path browser mechanism) reconcile as-built; CLAUDE.md mentions "Stagehand driving the configured LLM provider" — confirm wording still holds.
