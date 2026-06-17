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
- [ ] Commit as `Phase 5: <summary>`.
- [ ] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7).

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
