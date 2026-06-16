# Phase 4 — Agent Engine (Stagehand) & Playbook Compilation — Plan

> Status: **DRAFT**. Companion: [phase4_checklist.md](./phase4_checklist.md). Master refs: `PROJECT_SPEC.md` §9.1, §5.2 · `ARCHITECTURE.md` §4 (record→compile→parameterize), §3.4.

## Goal

The expensive path: learn a task from an instruction and **compile it into a playbook** the Phase-2 runner can replay. Isolation (Phase 3) already holds, so an agent run is just another isolated run. This phase makes the two-speed thesis real.

## Design decisions

- **Stagehand in `LOCAL` mode**, own Anthropic key, browser via the Phase-3 pool/context factory. No Browserbase.
- **This is the only place Stagehand and the Anthropic SDK are imported** (EXECUTION_STANDARDS §3 layering). The Phase-2 runner stays LLM-free.
- **Provenance by value identity, not text match** (ARCHITECTURE §4). The orchestrator builds a value→key reverse index from `data` before the run; the recorder tags each typed value with its `data` key by identity through the call. This is the mechanism that makes `{{data.*}}` templating correct — a value that also appears as static page text must not be mis-templated. Do not simplify to string replace.
- **Compile to the Phase-2 op vocabulary.** The compiler emits exactly the declarative ops the runner already interprets — if the agent does something the vocabulary can't express, that's a vocabulary gap to close, not a reason to embed code.

## File-by-file (indicative)

- `src/execution/agent/agent-engine.ts` — wraps `stagehand.agent()/act()/observe()/extract()`; guardrails (`agent_max_steps`, wall-clock reuse of Phase-3 timeout, domain confinement, `captcha_detected` short-circuit).
- `src/execution/agent/action-recorder.ts` — records `{op, selector, fallback_selectors, description, dataProvenance|literal}` in order.
- `src/execution/agent/provenance.ts` — value→key reverse index + identity tagging.
- `src/execution/agent/compiler.ts` — recorded actions → `vN.json`; parameterize; derive `required_data_keys`; attach `output_format`; carry `fallback_selectors` from `observe()`.
- `src/persistence/cache/selector-cache.ts` — local impl (persist `observe()` results so repeat agent ops skip inference; S3 backend deferred to Phase 6).

## Key behaviors

- Fresh `instruction`+`url` (no `playbook_id`) → agent mode → extract (if format) → evidence → compile → envelope carries new `playbook_id` + `version: 1` (`created_by: agent_initial`).
- `output_format` + existing `playbook_id` → new version with updated extraction step (reuse nav steps; re-invoke agent only if new fields can't be located) (`created_by: format_change`).
- `force_relearn` → fresh agent run → new version.
- Action-only (no `output_format`) → `playbook_type: "action"`, no extract step, `result: null`.

## Edge cases / risks

- **Parameterization that doesn't generalize.** The gate's plan-check is explicit: a replay with *different* `data` must work, not just a replay of the learned values. If it only works with the exact learned inputs, the provenance mechanism is wrong — fix it here, everything downstream assumes correct templating.
- **Coincidental value/text collision** — covered by the identity-not-text-match test.
- **Guardrails must actually fire** — step-budget exhaustion, off-site nav block, CAPTCHA short-circuit each produce the right error code.
- **Cost sanity** — record the token cost of an agent run vs the ~free replay in Notes; the economics are the whole point.

## Exit

The engine learns once and replays free, demonstrated end-to-end on a real Phase-0 site: agent→compile→replay round-trip green (the permanent release-blocker test), provenance-vs-page-text green, action-only green, guardrails green, generated `vN.json` inspected for sane selectors/parameterization.
