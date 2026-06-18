# Phase 5 — Self-Heal & Surfaced LLM Extraction Fallback — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase5_plan.md](./phase5_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [x] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full (re-read this session at the Phase 4 kickoff; re-confirmed).
- [x] Re-read [phase5_plan.md](./phase5_plan.md) and this checklist end to end.
- [x] Re-read the referenced master sections: PROJECT_SPEC.md §7 (heal table), §9.2, §9.3 · ARCHITECTURE.md §6.3, §6.4.
- [x] Confirm the **Phase 4 Plan & Verify gate actually passed** — verified this session: full learn→replay GREEN live (`test:live`) AND in-container (`docker-agent-check`), offline suite 63/1-skip, tsc+eslint clean.
- [x] Reconcile the plan against the codebase **as actually built** — `playbooks` already has `health` + `consecutive_heal_failures`; `runs.self_healed` exists; all four config flags resolve; repository `list` supports `?health=`. **Gaps to build:** `metrics.ts` not built (→ DB-count + defer Prometheus, DECISIONS #28); `ModelGateway` is resolution-only (→ gains the AI-SDK model call, #27); reservation release must move to the orchestrator for the replay→heal handoff (#28).
- [x] Verify library/API choices are still current — `ai@5.0.204` + `@ai-sdk/anthropic` present transitively via Stagehand (to be promoted to direct deps); others unchanged from Phase 4. Pinned in Notes.
- [x] Surface every open question / ambiguity / trade-off to the user — 4 surfaced + answered (verify posture, extraction-miss precedence, fallback model, thresholds/metrics scope → DECISIONS #25–#28).
- [x] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead** — plan + checklist + DECISIONS #25–#28 updated; **awaiting explicit "start Phase 5" before any code.**

---


Two resilience mechanisms that both lean on Phases 2+4. Self-heal = runner failure → agent → new version. LLM fallback = structural extraction miss → one-shot model extract, always surfaced.

> **Kickoff decisions applied (2026-06-17, DECISIONS #25–#28):** on a structural extraction miss → **fallback-first, then heal** (fallback if `on`; if still-missing AND `self_heal_on_extraction_failure` → heal; else `completed_with_extraction_errors`). Fallback model = cheaper **Haiku** (`anthropic/claude-haiku-4-5`); the `ModelGateway` gains the real AI-SDK `generateObject` call (`ai` + `@ai-sdk/anthropic` → direct deps). Unhealthy after **`HEAL_FAILURE_THRESHOLD=3`**; fallback engagements → **persistent per-playbook DB count** (new migration) feeding `FALLBACK_AS_DRIFT_SIGNAL`; **Prometheus deferred**. Capacity **reservation release moves to the orchestrator** (replay→heal handoff). Verify: offline logic + host `test:live` + in-container.

### Tasks

**Self-heal (architecture §6.4)** — `src/orchestrator/heal.ts` (classification) + `RunOrchestrator.healRun`
- [x] Failure classification per the spec §7 table. — `healPolicyForError`, exhaustive switch; `heal-classify.test.ts` asserts every `ERROR_CODES` entry (both config states).
- [x] On heal-eligible failure + resolved `playbook_self_heal=true`: same `run_id` continues in agent mode, `meta.mode=agent`, `meta.self_healed=true`. — offline (fake agent) + LIVE (mutate→heal) green.
- [x] Instruction source: stored `playbooks.instruction` (a replay payload carries no instruction; the payload-instruction path is Phase-4 `force_relearn`). — `healRun` reads `getContract`.
- [x] Success → compile `v(n+1)`, Postgres TXN (insert version → bump `active_version` → reset `consecutive_heal_failures` + `health='healthy'`), envelope carries new version. — `addVersionHealed`.
- [x] Failure → `failed` envelope, `heal_attempted:true`, `heal_outcome`; increment `consecutive_heal_failures`; flag `health=unhealthy` at threshold. — `recordHealFailure`; offline unhealthy test green.
- [x] Pinned-version runs that heal still write `v(n+1)` (never overwrite the pinned slot). — offline pinned-heal test (active 2 → writes 3, v1/v2 intact).

**LLM extraction fallback (architecture §6.3 / spec §9.2)** — `src/execution/playbook/llm-fallback.ts` via the `ModelGateway`
- [x] `LlmExtractFallback`: engaged only when structural extraction misses ≥1 field AND `REPLAY_LLM_FALLBACK=on`. — runner; offline on/off tests.
- [x] Uses `REPLAY_LLM_FALLBACK_MODEL`; resolves only the missing fields. — `buildSchema` over missing fields only; `generateObject`.
- [x] **Always surfaced:** `meta.llm_fallback_used=true` + `meta.fallback_fields`; run is `completed` if data now correct. — offline + LIVE (Haiku) green.
- [x] Metric `fallback_engaged_total{playbook_id}` → **persistent per-playbook DB count** (`fallback_engaged_count`, migration 0003); `FALLBACK_AS_DRIFT_SIGNAL=on` flags `health='needs_relearn'` after K (`recordFallbackEngagement`). Prometheus export deferred (DECISIONS #28).
- [x] Fallback still missing a field → that field is an `extraction_error` as normal. — runner removes only resolved fields from `extraction_errors`.

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

## ▣ Phase Review & Verification (mandatory — do before declaring the phase done)

Run this section literally, in order. A phase is **not done** until every box here is checked. Per EXECUTION_STANDARDS §1.6 and §5, green unit tests do not prove the behavior is right — re-verify by observation.

### Re-verification (cold)
- [x] Re-read this checklist top to bottom; every task box reflects observation (offline) or LIVE/in-Docker as noted.
- [x] Re-read the plan + `PROJECT_SPEC.md §7/§9.2/§9.3` / `ARCHITECTURE.md §6.3/§6.4`; built matches spec. As-built notes (fallback-first-then-heal, reservation-once-per-run, migrate advisory lock) synced to ARCHITECTURE + Notes.
- [x] `npx tsc --noEmit` clean; `eslint .` clean.
- [x] Full suite green — **74 passed, 3 skipped** (the 3 live tests). Phase 3 isolation + Phase 4 round-trip still green inside it.
- [x] **Cold start (offline + LIVE + in-Docker):** `docker compose up --build`; engine boots (migrations 0001–0003 applied). Offline replay/422 over HTTP; LIVE `test:live` (3 green: round-trip + heal + fallback); `scripts/docker-heal-check.ts` → **in-container self-heal (replay fails → agent learns v2 → v2 replays) + fallback (Haiku rescues a field): PASS**.

### Bug sweep
- [x] Walked the §7 table (every code's policy unit-asserted), heal config-off, extraction-miss precedence (fallback-first-then-heal), unhealthy threshold, pinned-heal, fallback on/off + still-missing. Found + fixed a **migrate concurrency race** (parallel test files raced to apply 0003) — added a Postgres advisory lock in `runMigrations`.
- [x] Defects fixed (migrate lock); re-ran the full suite green.
- [x] Re-ran affected scenarios; no regression (Phase 3 concurrency green after the reservation refactor).
- [x] Contract intact: `{meta,result}`, statuses, §7 codes unchanged. `meta.self_healed`/`llm_fallback_used`/`fallback_fields` are additive meta (already in the envelope type). Heal/fallback add no new error codes.

### Standing regression gates (must stay green once their phase has landed)
- [x] Phase 3 isolation cross-contamination test — green (in the full suite, after the reservation refactor).
- [x] Phase 4 learn→replay round-trip — green offline (compile→replay) + LIVE.

### Sign-off
- [x] Notes filled (versions, deviations, warnings, carried-forward).
- [x] `DECISIONS.md` updated (#25–#28, recorded at kickoff + gate).
- [x] `PROJECT_CHECKLIST.md` status reflects reality (Phase 5 complete; next Phase 6).
- [x] Commit as `Phase 5: <summary>`. — `Phase 5: self-heal & surfaced LLM extraction fallback`.
- [x] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7). — stopped; awaiting explicit Phase 6 go-ahead.

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

**Kickoff (2026-06-17) — pre-build:**
- **Pinned versions (to add as direct deps):** `ai@^5.0.204` + `@ai-sdk/anthropic` (already transitive via Stagehand; promote to direct for the gateway's `generateObject` fallback call). Re-confirm `@ai-sdk/anthropic` version with `npm view` before pinning. No other dep changes.
- **As-built readiness:** `playbooks.health` + `playbooks.consecutive_heal_failures` already exist (migration 0001); `runs.self_healed` exists; config resolver already has `playbook_self_heal` / `self_heal_on_extraction_failure` / `replay_llm_fallback` / `replay_llm_fallback_model`; `PlaybookRepository.list(healthFilter)` already supports `?health=`.
- **To build:** `src/orchestrator/heal.ts` (§7 classification + heal flow + version TXN + unhealthy flag); `src/execution/playbook/llm-fallback.ts` (one-shot extract via `ModelGateway`, surfaced); `ModelGateway` gains `generateObject`; runner wires the fallback; new migration for the per-playbook fallback-engagement count; `?health=unhealthy` already filterable. `HEAL_FAILURE_THRESHOLD` + `FALLBACK_AS_DRIFT_SIGNAL` + `FALLBACK_DRIFT_THRESHOLD` env keys (env-only, defaults).
- **Decisions (DECISIONS #25–#28):** verify posture (offline + host live + in-Docker); extraction-miss = fallback-first-then-heal; fallback model = Haiku; thresholds (heal=3) + DB-count drift + defer Prometheus; reservation release → orchestrator-owned.
- **Internal mechanism to get right (not a user decision):** the Phase-3 capacity reservation must be released **once per run** by the orchestrator, since a self-heal runs a second gated execution (`lifecycle.executeAgent`) on the same `run_id` after the failed replay — moving release out of `lifecycle.execute`/`executeAgent` avoids a double-release that would corrupt the `inFlight` 429 counter. The Phase-3 isolation/cap/backpressure tests must stay green after this refactor.
- **Highest-leverage correctness item:** the §7 heal-eligibility table — walk every code at the gate (eligible: `step_failed`, `navigation_failed`, `extraction_failed`-if-config; infra-retry: `browser_crashed`; never: `captcha_detected`/`timeout`/`validation_error`/`playbook_not_found`/`agent_gave_up`/`internal_error`).
- **Benign warnings / carried forward:** Prometheus metrics export (Phase 6/observability); real-site heal demo (with the deferred real-site work).

**Build (2026-06-17) — as-built:**
- **Pinned deps:** `ai@^5.0.204` + `@ai-sdk/anthropic@^2.0.83` as **direct** deps. Version note: `@ai-sdk/anthropic@3.x` targets `ai@6` (LanguageModelV3) and would mismatch Stagehand's `ai@5` (provider v2) — pinned to the `2.x` line (the version Stagehand already used), per DECISIONS #10 (don't force-upgrade what Stagehand owns).
- **New modules/migrations:** `src/orchestrator/heal.ts` (classification), `src/execution/playbook/llm-fallback.ts` (fallback + `ModelGatewayFallback`), `ModelGateway.extractObject` (`generateObject`, Anthropic wired), migration `0003_fallback_drift.sql` (`playbooks.fallback_engaged_count`, `runs.fallback_fields`), `RunStore.finishRun` gained mode/self_healed/llm_fallback_used/fallback_fields, `PlaybookRepository.addVersionHealed`/`recordHealFailure`/`recordFallbackEngagement`. Env: `HEAL_FAILURE_THRESHOLD`/`FALLBACK_AS_DRIFT_SIGNAL`/`FALLBACK_DRIFT_THRESHOLD`.
- **Reservation refactor (DECISIONS #28):** `lifecycle.execute`/`executeAgent` no longer release the capacity reservation; the orchestrator releases it ONCE per run (in `executePlaybook`/`executeAgent` finally) so a self-heal's second gated execution doesn't double-release. Phase-3 isolation/cap/backpressure tests re-run green.
- **Migrate concurrency fix:** `runMigrations` now holds a Postgres advisory lock on a dedicated connection, so parallel callers (test files, multiple replicas) serialize instead of racing to apply a new migration. (Surfaced as a full-suite flake the first time 0003 met the parallel test files.)
- **Deviations:** (1) heal uses the STORED instruction (replay payloads carry none); (2) `infra_retry` (browser_crashed) is classified but not actively triggered on the deterministic replay path (the runner classifies browser failures as step_failed/internal_error) — the retry mechanism is a small carried-forward; (3) the fallback model call is wired for Anthropic only this phase (other providers are a thin `buildModel` extension) — `generateObject` is provider-extensible.
- **Testability:** `AgentEngine` now implements an `AgentRunner` interface so heal tests inject a fake agent; `LlmExtractFallback` is already an interface for a fake fallback. Offline heal/fallback tests use dummy keys + fakes (zero real model calls).
- **Cost (live):** heal ≈ **10.2k input + 0.5k output** (one Sonnet agent run); fallback ≈ a single small Haiku `generateObject`. Replay after heal = 0 LLM.
- **Verification:** offline `heal-fallback.test.ts` (7) + `heal-classify.test.ts` (4); LIVE `test:live` (mutate→heal + fallback, green); in-Docker `docker-heal-check.ts` (heal + fallback, green).
