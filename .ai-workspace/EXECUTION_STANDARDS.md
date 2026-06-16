# Execution Standards (all phases, any model)

> These standards exist so that **any capable model executes the phase docs at the same quality**. They are not suggestions. Every phase in `PROJECT_CHECKLIST.md` ends with a Plan & Verify gate that assumes these standards are in force — re-read this file at every phase kickoff.
>
> Companion docs: `PROJECT_SPEC.md` (contract), `ARCHITECTURE.md` (mechanism + layering), `PROJECT_CHECKLIST.md` (phase tracker). When this file and a phase checklist disagree, the checklist wins for *what* to build; this file governs *how*.

## 1. How to execute a phase

1. Re-read this file and the target phase in `PROJECT_CHECKLIST.md` **completely** before writing any code. Confirm the previous phase's Plan & Verify gate actually passed (don't trust that it did — see §7). Get the user's explicit go.
2. Work the checklist **top to bottom**. The phase order is load-bearing (deterministic runner before agent; isolation before agent; transports last) — don't reorder within or across phases unless a dependency forces it, and note it if you do.
3. Check off items **only after verifying them yourself** — running the command, hitting the endpoint, seeing the row in Postgres, observing the envelope. Never from memory or assumption.
4. When the spec or architecture provides a **concrete shape** (the payload schema, the envelope, the declarative step vocabulary, the Postgres DDL, the error-code table), implement it **as written**. Adapt only for: API changes in installed library versions (Stagehand, Playwright, Fastify), TypeScript errors, or integration mismatches with as-built code — and record every adaptation in the checklist's Notes section.
5. Record in **Notes** as you go: pinned dependency versions, deviations + why, benign warnings, the token cost of agent runs you observe. An empty Notes section after a phase is a red flag, not a clean bill.
6. Finish with the phase's **Plan & Verify gate, executed literally** — re-read the spec sections it references, re-verify items, re-run the acceptance scenarios cold. Then commit and **STOP** (next phase only on user signal).

## 2. Divergence protocol

| Divergence | Action |
|---|---|
| Library API differs from the docs (Stagehand `act`/`extract`/`observe` signature, Playwright option rename, Fastify plugin change) | Adapt minimally, keep the documented intent, write it in Notes |
| A reference snippet doesn't compile or has a bug | Fix minimally, write what changed in Notes |
| The documented approach is impossible as specced (deprecated lib, Stagehand can't do what's assumed, platform restriction) | **STOP. Ask the user** with the problem + 2–3 options |
| You think there's a *better* design (different store, different op model, skip a tier) | **Do not implement it.** Follow the docs; suggest the idea in Notes or the spec §17 open-questions parking lot |
| Docs ambiguous on a detail with contract/behavior impact (a `meta` field, a status transition, a heal-eligibility) | **Ask the user** |
| Docs ambiguous on a trivial detail (a log message, an internal variable name) | Pick the obvious option matching surrounding code; don't ask |

The contract is sacred: the **payload shape, the `{meta, result}` envelope, the status vocabulary, and the error codes (`PROJECT_SPEC.md` §5–§7) must not drift**. If implementing reveals the contract is wrong, that's a STOP-and-ask, not a quiet change — every caller integrates against it.

## 3. Code standards

- **TypeScript strict.** No `any` (use `unknown` + narrowing, or a Zod-inferred type). Exported functions get explicit return types. No `@ts-ignore`/`@ts-expect-error` without a Notes entry.
- **Layering (import rules, from `ARCHITECTURE.md` §3 and §12):**
  - `execution/playbook/` (runner, step interpreter, structural extractor) imports **no** Stagehand and **no** Anthropic SDK — it is the zero-LLM path and must stay that way. A Stagehand import here is a Phase Review failure.
  - `execution/agent/` is the only place Stagehand and the Anthropic SDK are imported.
  - `persistence/` exposes interfaces (`PlaybookStore`, `EvidenceStore`, `RunStore`, `SelectorCache`); everything above it is backend-agnostic and must not branch on `local` vs `s3`/`postgres` itself.
  - `transport/` (Fastify routes, SQS consumer) contains **no** business logic — it validates, hands a job to the orchestrator, and serializes the envelope back. One orchestrator serves both transports.
  - `intake/` (validator, config resolver, idempotency, auth) and `orchestrator/` never import `transport/`.
- **Isolation is a code-level invariant, not a config (`ARCHITECTURE.md` §8.1):** no module-level mutable run state, ever. A run's context (`run_id`, bound `data`, resolved config, recorder, evidence paths) is threaded explicitly as an argument. One Playwright `BrowserContext` per run; **never** reuse or pool a `Page`/`BrowserContext`/Stagehand instance across runs. A `let currentRun`-style global is an automatic Phase Review failure.
- **Data provenance (`ARCHITECTURE.md` §4):** `data` values become `{{data.key}}` in playbooks by **value-identity tracking through the call**, never by scanning page text. Don't "simplify" this to a string replace — it silently mis-templates.
- **Naming:** `camelCase` functions/variables, `PascalCase` types/classes, `UPPER_SNAKE` module constants and env vars. Files `camelCase.ts`. Named exports, one concern per module.
- **Error posture:** the engine degrades into a clean `failed` / `completed_with_extraction_errors` envelope, it never throws past the service boundary. Every external failure (target site, browser crash, storage, Anthropic API) is caught, classified to an error code from the §7 set, and surfaced in `meta.error` — never an uncaught 500 with a stack trace to the caller. `logger.warn` for recoverable oddities.
- **Comments:** only for non-obvious constraints (e.g., "provenance is by value identity, not text match — see ARCHITECTURE §4"). No narration.
- **Config & tunables:** all behavior knobs go through the `ConfigResolver` (`payload.config > env > default`, `PROJECT_SPEC.md` §10). Never read `process.env` directly in business logic, and never inline a magic timeout/limit. Capacity limits (`MAX_CONCURRENT_RUNS`, `MAX_QUEUE_DEPTH`, `BROWSER_RECYCLE_RUNS`, `MAX_RUN_TIMEOUT_SECONDS`) are **env-only** and must not be payload-overridable.
- **Migrations:** any change to the Postgres schema (`ARCHITECTURE.md` §5.1) ships as a numbered migration in the same commit, and the migration runs clean against a DB created from the previous migration. Never edit a shipped migration in place.

## 4. Contract & data-handling standards

- **Envelope discipline:** `result` is **only ever** the caller's `output_format` shape or `null`. System info lives in `meta`. Never inject an engine field into `result`. New `meta` fields are additive only.
- **Playbooks are data, never code:** the runner interprets a fixed op vocabulary (`PROJECT_SPEC.md` §8.2). Nothing from a playbook body is ever `eval`'d, `Function()`'d, or otherwise executed. Adding an op means extending the interpreter, not embedding code in the playbook.
- **Honest results:** a field that can't be extracted is reported missing (`extraction_errors`), never guessed or hallucinated. The LLM extraction fallback, when it engages, is **always surfaced** (`meta.llm_fallback_used`, `meta.fallback_fields`) — a silent rescue is a bug.
- **Sensitive data:** `data` values are redacted in logs and traces, and **never** persisted into playbook bodies (only `{{data.*}}` refs). Run rows store data *keys*, not values, unless `STORE_RUN_INPUTS=true`. A playbook body or log line containing a raw `data` value is a Phase 7 security failure — there's an automated scan for it.
- **SSRF:** `url` and every agent navigation are validated against the deny rules (`ARCHITECTURE.md` §9) — no private/link-local/metadata targets unless explicitly allowlisted. This holds for agent mode too, not just the initial `url`.

## 5. Verification discipline

- `npx tsc --noEmit` must be clean **before every commit** — zero errors, no new warnings introduced silently.
- The test suite (`vitest`/`jest`) must be green before a phase's gate passes. Integration tests run against the **bundled fixture site** fully offline (only the Anthropic API may be live, and only in agent-mode tests).
- Each checklist verify-item has a command or manual scenario and a **"done means"** — observe that exact outcome (the row appears, the `429` returns, the second run sees only its own cookie). If the outcome differs, the item is NOT done: fix or record divergence.
- **Cold-start rule:** a phase's gate re-runs key scenarios after a fresh `docker compose down && up` (or a fresh process start) — not against a warm dev server whose in-memory state can mask a persistence or startup bug.
- **The two release-blocking tests** (`PROJECT_CHECKLIST.md` close-out) must pass and stay passing once their phase lands:
  1. **Phase 3 isolation cross-contamination test** — N concurrent runs each see only their own session state. This is the single most important test in the project.
  2. **Phase 4 learn→replay round-trip** — a freshly compiled playbook replays with *different* `data` and no LLM. This is the two-speed thesis.
  A regression in either is a release blocker regardless of the active phase.
- **Concurrency claims require a concurrency test:** never assert isolation or capacity behavior from a single-request run. Fire a burst.

## 6. Commit & doc-sync protocol

- Phase commits: `Phase N: <summary>`. Mid-phase WIP commits allowed (`Phase N WIP: <what>`) if a session must stop early — update the checklist's phase status in the same commit.
- Every user-confirmed decision → append a row to `DECISIONS.md` in the same commit (auth mode, sync-mode in/out, the project name, list-data approach, etc. — the `PROJECT_SPEC.md` §17 open questions resolve here).
- As-built drift from the docs → sync `PROJECT_SPEC.md` / `ARCHITECTURE.md` in the phase's gate, so the three docs never lie about the running system. (We've already had to re-sync these once; keep them honest.)
- At every stopping point (any reason): the checklist's task boxes and any status block reflect reality — active phase, last completed item, next item, blockers.

## 7. What NOT to do (cross-phase)

- Don't start or plan the next phase after finishing one — STOP for the user.
- Don't put an LLM call on the playbook (replay) path "for convenience." The whole economic model is that replays are deterministic and free; the only sanctioned LLM-on-replay is the surfaced, config-gated extraction fallback.
- Don't reuse browser contexts/pages across runs to "save startup time" — it's the canonical way cross-request contamination gets introduced (§3, `ARCHITECTURE.md` §8.1).
- Don't refactor code outside the phase's scope ("while I'm here…") — Notes or the §17 parking lot instead.
- Don't add dependencies the docs don't list without asking. (Stagehand, Playwright, Fastify, a Postgres client, Zod, a logger, an SQS/S3 SDK are expected; anything beyond needs a reason in Notes or a user OK.)
- Don't weaken a checklist item to make it pass (e.g., asserting isolation from a single run, or skipping the cold-start) — record it as not-done with the reason.
- Don't let the contract drift silently (§2). Payload, envelope, statuses, and error codes are the public surface.
- Don't trust that an earlier phase was implemented exactly to the docs — the kickoff revisit (§1.1) exists because reality drifts.
