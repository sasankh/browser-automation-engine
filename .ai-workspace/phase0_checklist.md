# Phase 0 — Foundations & Decisions — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase0_plan.md](./phase0_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [ ] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full.
- [ ] Re-read [phase0_plan.md](./phase0_plan.md) and this checklist end to end.
- [ ] Re-read the referenced master sections: PROJECT_SPEC.md §17 (resolved decisions + open questions).

- [ ] Reconcile the plan against the codebase **as actually built** — note any drift from earlier-phase assumptions.
- [ ] Verify library/API choices are still current (Stagehand, Playwright, Fastify, Anthropic SDK, pg, Zod) — pin versions in the plan's Notes.
- [ ] Surface every open question / ambiguity / trade-off to the user. Contract-affecting ambiguity is a STOP-and-ask.
- [ ] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. Only then execute.

---


Lock the inputs so no later phase stalls on an unanswered question.

### Tasks
- [ ] Confirm locked decisions from spec §17: TypeScript/Node 22, Postgres everywhere, structural-first extraction with surfaced LLM fallback, three-limit concurrency model.
- [ ] Decide **API auth mode** for v1 (`none` | `api_key` | `hmac`). Default assumption: `none` for first internal deploy, `hmac` reserved. Record the choice.
- [ ] Decide **sync mode** (`?wait=true`) in or out for v1. Default: out (async-only).
- [ ] Pick the **project name** (replaces "engine" placeholder) — affects package name, ID prefixes, image name.
- [ ] Provision an **Anthropic API key** and confirm Stagehand can reach it from a local container.
- [ ] Confirm **target test sites**: pick 2–3 real public sites with lookup forms for end-to-end validation (no auth, no CAPTCHA) + the bundled fixture site.
- [ ] Repository created; license; CODEOWNERS; branch protection.
- [ ] Decide ID scheme: `run_...`, `pb_...` (ULID/KSUID for sortability). Record prefix constants.

### Acceptance criteria
- All four spec §17 "resolved" items are reflected in a short `DECISIONS.md` in the repo.
- The three still-open-but-non-blocking questions have a recorded default so Phase 1 can proceed.

### ▣ Plan & Verify gate — Phase 0
- **Plan check:** Is every input Phase 1 needs now decided or defaulted? (runtime, DB, auth, name, IDs, API key, test sites)
- **Verify:** `DECISIONS.md` exists and is reviewed. Anthropic key works from a throwaway container (`curl` the API or a 3-line Stagehand smoke). No open question blocks scaffolding.
- **Exit condition:** a second person could start Phase 1 from the repo with no verbal context.

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
- [ ] Commit as `Phase 0: <summary>`.
- [ ] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7).

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

- Pinned versions:
- Deviations from plan (+ why):
- Benign warnings observed:
- Open items carried forward:
