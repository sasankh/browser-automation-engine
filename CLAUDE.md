# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **Universal Instruction-Driven Browser Automation Engine**: a self-hosted, Dockerized service that performs browser tasks on any website from natural-language instructions. The defining idea is **two-speed execution** — the first run of a task uses an AI agent (Stagehand + Claude API) to figure it out and **compiles the result into a versioned, parameterized "playbook"**; every later run replays that playbook with plain Playwright, no LLM, near-zero cost. When a playbook breaks (site redesign), the agent **self-heals** it into a new version. The engine is domain-agnostic — callers supply the task, target, inputs, and output shape.

Read [PROJECT_SPEC.md](PROJECT_SPEC.md) (the *what* + external contract) and [ARCHITECTURE.md](ARCHITECTURE.md) (the *how* + internal layering) before doing substantive work. [ARCHITECTURE.md](ARCHITECTURE.md) §4 walks the core Record→Compile→Parameterize→Replay mechanism end to end.

## Current state: spec stage, no code yet

There is **no source code, no `package.json`, and no commits** — only design docs and a phased build plan. Do not assume any command below runs yet; they are the *planned* interface and become real as phases land. Do not scaffold code unprompted: this project is built phase-by-phase under an explicit human go-ahead (see below).

## Build discipline is mandatory — read before coding

This repo is built incrementally through **Phases 0–7**, and the process is as load-bearing as the code. Before writing anything:

1. Read [.ai-workspace/EXECUTION_STANDARDS.md](.ai-workspace/EXECUTION_STANDARDS.md) **in full** — it governs *how* every phase is executed (code standards, divergence protocol, verification discipline) and is meant to be re-read at every phase kickoff.
2. Read the active phase's two docs in [.ai-workspace/](.ai-workspace/): `phaseN_plan.md` (deep-dive design) and `phaseN_checklist.md` (executable checklist). [PROJECT_CHECKLIST.md](PROJECT_CHECKLIST.md) is the high-level index across all phases.

Non-negotiable process rules (from [EXECUTION_STANDARDS.md](.ai-workspace/EXECUTION_STANDARDS.md) and [.ai-workspace/README.md](.ai-workspace/README.md)):

- **Phases never auto-start.** When a phase's gate passes and you commit, **STOP**. The next phase begins only when the user explicitly says so. Do not plan ahead into the next phase.
- **Phase Kickoff Revisit (§0 of every checklist):** at the start of a phase, re-read the plan/checklist + referenced spec/architecture sections, reconcile them against the code *as actually built* (earlier phases drift), re-verify library/API currency (Stagehand, Playwright, Fastify, Anthropic SDK, pg, Zod move fast — pin versions in Notes), surface every open question to the user, get an explicit go-ahead.
- **Plan & Verify gate** ends every phase: re-verify each checklist item *by observation* (run the command, see the Postgres row, observe the envelope — never from memory), `npx tsc --noEmit` clean, tests green, and **cold-start re-run** (`docker compose down && up`, not a warm dev server) of the acceptance scenarios.
- **Divergence protocol:** adapt minimally for real library-API differences and record it in the checklist's **Notes**; but if the documented approach is impossible, ambiguous on anything contract-affecting, or you think there's a *better* design — **STOP and ask / park it in spec §17**, do not silently implement it.
- **Doc-sync:** every user-confirmed decision appends a row to [DECISIONS.md](DECISIONS.md) in the same commit; as-built drift syncs back into [PROJECT_SPEC.md](PROJECT_SPEC.md) / [ARCHITECTURE.md](ARCHITECTURE.md) so the three docs never lie about the running system. Commit messages: `Phase N: <summary>` (or `Phase N WIP: <what>`).

## Architectural invariants that are easy to violate

These are correctness requirements, not style preferences. Breaking one is a Phase Review failure.

- **The contract is sacred.** The request payload shape, the `{ meta, result }` response envelope, the status vocabulary, and the error-code set ([PROJECT_SPEC.md](PROJECT_SPEC.md) §5–§7) are the public surface every caller integrates against. `result` is **only ever** the caller's `output_format` shape or `null` — all system info lives in `meta`, new `meta` fields are additive only. Changing the contract is a STOP-and-ask, never a quiet edit.
- **Playbooks are data, never code.** A playbook is declarative JSON interpreted by a fixed op vocabulary (`goto`/`click`/`fill`/`select`/`extract`/… — [PROJECT_SPEC.md](PROJECT_SPEC.md) §8.2). Nothing learned by the LLM is ever `eval`'d / `Function()`'d. Adding a capability means extending the interpreter, not embedding code in a playbook body.
- **Layering / import rules** ([ARCHITECTURE.md](ARCHITECTURE.md) §3, §12):
  - `execution/playbook/` (runner, step interpreter, structural extractor) is the **zero-LLM path** — it imports **no Stagehand and no Anthropic SDK**. A Stagehand import here is an automatic review failure.
  - `execution/agent/` is the **only** place Stagehand and the Anthropic SDK are imported.
  - `persistence/` exposes interfaces (`PlaybookStore`, `EvidenceStore`, `RunStore`, `SelectorCache`); everything above is backend-agnostic and must not branch on `local` vs `s3`/`postgres`.
  - `transport/` (Fastify routes, SQS consumer) holds **no business logic** — validate, hand a job to the one `RunOrchestrator`, serialize the envelope back. Both transports share one orchestrator.
- **Request isolation** ([ARCHITECTURE.md](ARCHITECTURE.md) §8.1): **one Playwright `BrowserContext` per run**, created at start and closed at end; **never** pool/reuse a `Page`/`BrowserContext`/Stagehand instance across runs (the "reuse the page to save startup time" optimization is explicitly forbidden — it is *the* way cross-request contamination gets introduced). **No module-level mutable run state** — a run's context (`run_id`, bound `data`, resolved config, recorder, evidence paths) is threaded explicitly as an argument. A `let currentRun`-style global is an automatic failure.
- **Provenance-driven templating** ([ARCHITECTURE.md](ARCHITECTURE.md) §4): `data` values become `{{data.key}}` in playbooks by **value-identity tracking through the agent's calls**, never by scanning page text for the string. Do not "simplify" this to a string replace — it silently mis-templates when a data value coincides with page text.
- **Honest results:** a field that can't be extracted is reported missing (`extraction_errors`), never guessed. The replay LLM extraction fallback, when it engages, is **always surfaced** (`meta.llm_fallback_used`, `meta.fallback_fields`) — a silent rescue is a bug. Never put an LLM call on the replay path except this one config-gated, surfaced fallback.
- **Config flows one way; data never leaks.** All behavior knobs resolve through `ConfigResolver` as **payload.config > env > built-in default** ([PROJECT_SPEC.md](PROJECT_SPEC.md) §10) — never read `process.env` directly in business logic. Payload config can change *behavior* but never *destinations* (storage/SQS/webhooks/secrets are env-only) and never *capacity ceilings* (`MAX_CONCURRENT_RUNS`, `MAX_QUEUE_DEPTH`, `BROWSER_RECYCLE_RUNS`, `MAX_RUN_TIMEOUT_SECONDS` are env-only). Sensitive `data` values are redacted in logs and never persisted into playbook bodies — only `{{data.*}}` refs.

## Two release-blocking regression tests

Once their phase lands, these must pass and stay passing in every later phase (a regression blocks release regardless of the active phase):

1. **Phase 3 isolation cross-contamination test** — N concurrent runs each see only their own session/cookie state. The single most important test in the project. Concurrency claims require an actual burst, never a single-request assertion.
2. **Phase 4 learn→replay round-trip** — a freshly compiled playbook replays with *different* `data` and no LLM. This is the two-speed thesis.

## Tech stack & layout (planned)

- **Runtime:** TypeScript / Node 22 (strict mode — no `any`; use `unknown` + narrowing or Zod-inferred types). Stagehand is TS-native, which drove the runtime choice.
- **Server:** Fastify; **validation:** Zod; **logging:** pino (structured JSON, `run_id`-scoped, redacted).
- **Browser:** Playwright + Chromium; agent layer uses Stagehand.
- **Store:** PostgreSQL everywhere for run records + playbook index (transactional `active_version` pointer moves); playbook *bodies* and evidence are blobs in local FS or S3. Schema in [ARCHITECTURE.md](ARCHITECTURE.md) §5.1; any schema change ships as a numbered migration in the same commit and is never edited in place.
- **Transports:** HTTP (always) + SQS (config-gated); `SERVICE_MODE` ∈ `all | api | worker`.
- Planned `src/` module layout is in [ARCHITECTURE.md](ARCHITECTURE.md) §12.

## Commands (planned — confirm as Phase 1 lands)

From [LOCAL_DEV.md](LOCAL_DEV.md); these do not exist until the skeleton is built:

```bash
docker compose up --build     # engine + Postgres (SERVICE_MODE=all, local FS storage)
curl localhost:8080/v1/health # liveness + live saturation (runs_in_progress, queue_depth)

npm test                      # unit + integration, fully offline against the bundled fixture site
npx tsc --noEmit              # must be clean before EVERY commit
npm run test:live             # opt-in: real agent runs vs fixture (needs ANTHROPIC_API_KEY)
npm run migrate               # Postgres migrations (also run automatically on engine start)
```

Integration tests run offline against a bundled express **fixture site** (`test/fixtures/site`) with lookup→results, action-only, and mutated (heal-test) variants — only the Anthropic API is ever live, and only in agent-mode tests. Replay/runner work needs no API key. To run a single test, use the underlying runner's filter (e.g. `npx vitest run <file>` / `-t <name>`) once the test tooling is chosen in Phase 1.
