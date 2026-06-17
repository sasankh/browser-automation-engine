# Phase 5 — Self-Heal & Surfaced LLM Extraction Fallback — Plan

> Status: **DRAFT**. Companion: [phase5_checklist.md](./phase5_checklist.md). Master refs: `PROJECT_SPEC.md` §7 (heal table), §9.2, §9.3 · `ARCHITECTURE.md` §6.3, §6.4.

## Goal

Two resilience mechanisms that both lean on Phases 2+4. **Self-heal** = a runner failure escalates to agent mode and writes a new playbook version. **LLM extraction fallback** = a structural extraction miss triggers a one-shot model extract — always surfaced. Together they make the system maintenance-free in the common case.

## Design decisions

- **Self-heal is "agent mode triggered by a runner failure"** — it reuses Phase 4 wholesale. Same `run_id` continues; `meta.mode` becomes `agent`; `meta.self_healed: true`.
- **Heal eligibility is defined for every error code** (spec §7 table — this was made exhaustive during a doc recheck). Eligible: `step_failed`, `navigation_failed`, and `extraction_failed` *only if* `self_heal_on_extraction_failure`. Infra-retry (not agent): `browser_crashed`. Never heal: `captcha_detected`, `timeout`, `validation_error`, `playbook_not_found`, `agent_gave_up`, `internal_error`. Get this table exactly right — wrong classification either burns tokens healing un-healable failures or silently rots playbooks.
- **The LLM fallback is never silent.** It engages only when structural extraction misses ≥1 field AND `REPLAY_LLM_FALLBACK=on`; when it engages it always sets `meta.llm_fallback_used` + `meta.fallback_fields` and increments `fallback_engaged_total{playbook_id}`. A `completed` run that needed the fallback is still counted so drift is visible (EXECUTION_STANDARDS §4).
- **Append-only versioning preserved.** Heal writes `v(n+1)` in a single Postgres transaction (insert version → bump `active_version` → reset `consecutive_heal_failures`). A pinned-version run that heals still writes `v(n+1)` — never overwrites the pinned slot.

## File-by-file (indicative)

- `src/orchestrator/heal.ts` — failure classification per the §7 table; heal flow; version bump + pointer move; `consecutive_heal_failures` increment + `unhealthy` flagging at threshold.
- `src/execution/playbook/llm-fallback.ts` — one-shot extract of missing fields via the **`ModelGateway`** (model = `REPLAY_LLM_FALLBACK_MODEL`, `provider/name`; DECISIONS #11), never importing a provider SDK directly; surfacing.
- `src/transport/routes/playbooks.ts` — extend with `?health=unhealthy` filter.

## Key behaviors

- Instruction source for heal: payload instruction if present, else the stored `playbooks.instruction`.
- Heal respects config: `playbook_self_heal=false` → the failure returns `failed` with `heal_attempted: false`.
- Fallback off (default): structural miss → `completed_with_extraction_errors`, no LLM call.

## Edge cases / risks

- **Misclassified error codes** — the gate's plan-check walks the entire §7 list and confirms each code's policy. This is the highest-leverage correctness item in the phase.
- **Heal storms** — repeated heal failures must flag `unhealthy` (surfaced via the filter) rather than retrying forever.
- **Fallback masking drift** — confirm the metric increments and (optionally, `FALLBACK_AS_DRIFT_SIGNAL=on`) the playbook is flagged for re-learn after K engagements.

## Exit

Maintenance-free in the common case: the mutate-and-heal end-to-end test passes (v1 fails on the mutated fixture → heals → v2 replays cleanly, `meta.self_healed=true`); heal respects config; non-eligible codes never heal; unhealthy flagging works; fallback surfacing verified both on and off; a healed `v2` diff vs `v1` is sensible.
