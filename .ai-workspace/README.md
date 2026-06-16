# .ai-workspace

Per-phase working documents for the engine build. Convention:

- Master docs live at repo root: [PROJECT_SPEC.md](../PROJECT_SPEC.md) (what & the contract), [ARCHITECTURE.md](../ARCHITECTURE.md) (how it's built), and [PROJECT_CHECKLIST.md](../PROJECT_CHECKLIST.md) (high-level index of all phases). Execution rules for every phase live in [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) — re-read it at every phase kickoff.
- **All phase docs are authored upfront as DRAFTs**, two files per phase:
  - `phaseN_plan.md` — deep-dive plan for that phase only: goal, design decisions, file-by-file specification, edge cases, risks, the spec/architecture sections it implements.
  - `phaseN_checklist.md` — granular executable checklist, checked off during the phase.
- **Phase Kickoff Revisit (mandatory, §0 of every checklist):** when the user says to start phase N — re-read the phase plan/checklist and the referenced `PROJECT_SPEC.md` / `ARCHITECTURE.md` sections, reconcile them against the codebase as actually built (earlier phases may have changed assumptions), verify library/API choices are still current (Stagehand, Playwright, Fastify, the Anthropic SDK move fast), update the docs, surface any open questions to the user, and get an explicit go-ahead. Only then execute.
- Every phase checklist **ends with a mandatory "Plan & Verify gate"** — re-verify every item, `tsc --noEmit`, build, re-run the acceptance scenarios cold (fresh `docker compose down && up`), fix anything found. A phase is not done until the gate passes.
- **During phase planning, the AI must surface any open questions to the user** (decisions, ambiguities, trade-offs) before execution — never silently assume. Contract-affecting ambiguity (payload, envelope, statuses, error codes) is always a STOP-and-ask.
- **Phases never auto-start.** When a phase finishes (gate passed, committed), STOP. The next phase's planning begins only when the user says so.
- When a phase's design is confirmed, update the matching section of [PROJECT_SPEC.md](../PROJECT_SPEC.md) and [ARCHITECTURE.md](../ARCHITECTURE.md) to reflect any as-built decisions, so the master docs never lie about the running system.
- Every user-confirmed decision gets appended to [DECISIONS.md](../DECISIONS.md) in the same commit. New feature ideas go to the `PROJECT_SPEC.md` §17 open-questions parking lot instead of expanding scope.
- At every stopping point, the status reflected in `PROJECT_CHECKLIST.md` (active phase, last completed item, next item, blockers) is updated so any future session can resume cold.

The two release-blocking tests, once their phase lands, must pass and stay passing in every later phase: the **Phase 3 isolation cross-contamination test** and the **Phase 4 learn→replay round-trip**. A regression in either blocks release regardless of the active phase.

Phase numbering (consistent everywhere — `PROJECT_SPEC.md` §16, `PROJECT_CHECKLIST.md`, and these docs all use Phase 0–7):

| Phase | Scope |
|---|---|
| 0 | Foundations & decisions |
| 1 | Skeleton (API, config, Postgres, envelope, Docker) |
| 2 | Playbook runner (deterministic, no LLM) |
| 3 | Concurrency core & request isolation |
| 4 | Agent engine (Stagehand) & playbook compilation |
| 5 | Self-heal & surfaced LLM extraction fallback |
| 6 | Transports & storage backends (webhooks, SQS, S3, modes) |
| 7 | Hardening, security, observability, docs |
