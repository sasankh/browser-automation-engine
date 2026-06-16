# Phase 2 — Playbook Runner (deterministic, no LLM) — Plan

> Status: **DRAFT**. Companion: [phase2_checklist.md](./phase2_checklist.md). Master refs: `PROJECT_SPEC.md` §8 · `ARCHITECTURE.md` §8.1 (paths), §5.

## Goal

Build the cheap path: execute a **declarative playbook** against a site with plain Playwright, no LLM. Playbooks are **hand-authored fixtures** this phase — the agent that writes them is Phase 4 — which isolates the step interpreter from the compiler and lets us prove the runner first.

## Design decisions

- **Declarative JSON ops, interpreted — never generated code** (ARCHITECTURE §4.4). The interpreter maps a fixed op vocabulary to Playwright calls. This is the safety-and-portability cornerstone; do not shortcut to `eval`'d code.
- **Fixture-site-first.** A bundled express app under `test/fixtures/site` gives offline, deterministic integration tests. Three variants: a lookup→results flow (extraction), an action-only form (no results), and a mutated variant (renamed selector) reserved for Phase 5 heal tests.
- **Structural extraction only** this phase. Missing fields → `extraction_errors` + `completed_with_extraction_errors`. The LLM fallback is explicitly Phase 5 — do not add it here.
- **Local storage backends** only (`PlaybookStore`/`EvidenceStore` local impls). S3 is Phase 6 behind the same interface.

## File-by-file (indicative)

- `src/execution/playbook/runner.ts` — orchestrates: load version → validate data → interpret → extract → evidence → envelope.
- `src/execution/playbook/step-interpreter.ts` — op vocabulary: `goto, click, fill, select, check, press, wait_for, wait_ms, scroll, extract, screenshot`; primary→`fallback_selectors`→`step_failed`.
- `src/execution/playbook/structural-extractor.ts` — pull `output_format` fields by stored scope/selectors; per-field success.
- `src/persistence/playbooks/store.local.ts` + `index.pg.ts` — bodies on disk (`meta.json` + `vN.json`), index rows in Postgres, `body_uri` pointer.
- `src/persistence/evidence/evidence.local.ts` — screenshot + HTML under `evidence/{run_id}/`.
- `src/transport/routes/playbooks.ts` — list/get/versions/activate/delete.
- `test/fixtures/site/*` — the express fixture.

## Key behaviors

- **Replay wiring:** `POST /v1/runs` with `playbook_id` → load active (or pinned) version → validate `data` vs `required_data_keys` (fail-fast `422` **before** a browser launches) → run.
- **Versioning:** `meta.json.active_version` pointer; `activate` is a single Postgres transaction; pinned `playbook_version` runs that exact version and never moves the pointer; `DELETE` is a soft tombstone (versions retained).

## Edge cases

- Missing required data key → `422`, no browser.
- Action-only playbook → `result: null`, `completed`.
- Field absent on page → `completed_with_extraction_errors` with the right `extraction_errors`, never a guess.
- Pinned version vs active pointer divergence — both must resolve correctly.

## Risks

- **Op vocabulary insufficiency for real sites.** The gate's plan-check requires hand-authoring a playbook for one real Phase-0 site and adding any missing ops *now*, while the interpreter is the only consumer (Phase 4's compiler will target whatever vocabulary exists).
- **Selector brittleness** is expected and is what `fallback_selectors` + Phase 5 heal address — don't over-engineer selector robustness here.

## Exit

Deterministic replay is trustworthy and observable: correct extraction, action-only, and partial-extraction cases all pass offline against the fixture; versioning/activate/rollback work; a real-site hand-authored playbook runs. p50 < 30s on the fixture.
