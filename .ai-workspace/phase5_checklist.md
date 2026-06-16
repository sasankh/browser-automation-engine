# Phase 5 — Self-Heal & Surfaced LLM Extraction Fallback — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase5_plan.md](./phase5_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [ ] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full.
- [ ] Re-read [phase5_plan.md](./phase5_plan.md) and this checklist end to end.
- [ ] Re-read the referenced master sections: PROJECT_SPEC.md §7 (heal table), §9.2, §9.3 · ARCHITECTURE.md §6.3, §6.4.
- [ ] Confirm the **Phase 4 Plan & Verify gate actually passed** — don't trust the checkbox; spot-check that Phase 4's exit condition holds against the code as built (EXECUTION_STANDARDS §7).
- [ ] Reconcile the plan against the codebase **as actually built** — note any drift from earlier-phase assumptions.
- [ ] Verify library/API choices are still current (Stagehand, Playwright, Fastify, Anthropic SDK, pg, Zod) — pin versions in the plan's Notes.
- [ ] Surface every open question / ambiguity / trade-off to the user. Contract-affecting ambiguity is a STOP-and-ask.
- [ ] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. Only then execute.

---


Two resilience mechanisms that both lean on Phases 2+4. Self-heal = runner failure → agent → new version. LLM fallback = structural extraction miss → one-shot model extract, always surfaced.

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

- Pinned versions:
- Deviations from plan (+ why):
- Benign warnings observed:
- Open items carried forward:
