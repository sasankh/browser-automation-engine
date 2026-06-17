# Phase 4 — Agent Engine (Stagehand) & Playbook Compilation — Plan

> Status: **DRAFT**. Companion: [phase4_checklist.md](./phase4_checklist.md). Master refs: `PROJECT_SPEC.md` §9.1, §5.2 · `ARCHITECTURE.md` §4 (record→compile→parameterize), §3.4.

## Goal

The expensive path: learn a task from an instruction and **compile it into a playbook** the Phase-2 runner can replay. Isolation (Phase 3) already holds, so an agent run is just another isolated run. This phase makes the two-speed thesis real.

## Design decisions

- **Stagehand v3.5 (latest stable) in `env: LOCAL`**, pointed at the resolved provider/model through the **`ModelGateway`** (Anthropic/OpenAI/Google/local — DECISIONS #11); provider key/endpoint from env. No Browserbase. **Stagehand v3 is CDP-native and owns its own browser** — it will not run on the Phase-3 Playwright `BrowserContext` (rejects an external Page, upstream issue #1392). So **each agent run launches one Stagehand instance** (`localBrowserLaunchOptions`: headless/proxy/args from config), one instance = one isolated session, disposed at run end (DECISIONS #21). Concurrency + the wall-clock timeout still flow through the Phase-3 `Lifecycle` (teardown closes the Stagehand instance); the Playwright `BrowserPool` stays the **replay** path's browser. Evidence (screenshot + HTML) is captured via `stagehand.page`.
- **`execution/agent/` and the `ModelGateway` are the only place Stagehand and the model-provider SDKs (Vercel AI SDK + `@ai-sdk/*`) are imported** (EXECUTION_STANDARDS §3 layering). The Phase-2 runner stays LLM-free.
- **Phase 0 carry-in (resolved at kickoff 2026-06-17):** add the explicit `ModelGateway` build task + module on the Vercel AI SDK; wire the **require-explicit `model`** rule (agent runs validate `model` = `provider/name` upfront → `validation_error` if absent, DECISIONS #11). The `agent()`-provider-coverage worry is **retired**: Stagehand v3.5 selects models as `provider/name` (incl. `agent()`) natively via the Vercel AI SDK — `agent()` is *not* provider-narrow. Note: Stagehand owns model selection internally in v3, so the `ModelGateway`'s job here is (a) enforce require-explicit + resolve `provider/name` and (b) own the model-call for the Phase-5 `LlmExtractFallback`; the agent's model is passed to Stagehand as the resolved `model` string + env key (not a hand-built provider client).
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

The engine learns once and replays free, demonstrated end-to-end: agent→compile→replay round-trip green (the permanent release-blocker test), provenance-vs-page-text green, action-only green, guardrails green, generated `vN.json` inspected for sane selectors/parameterization. **This phase's completion is fixture-complete** (DECISIONS #22); the real-site end-to-end demonstration is carried forward (see kickoff notes).

**Live verification (required for the gate — both host and Docker):**
- **Host:** `npm run test:live` (real Anthropic Sonnet) — full learn→replay round-trip green.
- **In-container (cold-start gate):** `docker compose up --build -d` then `npx tsx scripts/docker-agent-check.ts` — the agent learns the `fixture:3100` form INSIDE the dockerized engine and the compiled playbook replays with different data + no LLM. Proves Chromium-in-image launch, model egress, and key/`/v1`-base-URL handling work in the container — not just on the host. Needs `ANTHROPIC_API_KEY` + `CHROME_PATH` in the engine container (wired in `docker-compose.yml`, key interpolated from `.env`).

## Kickoff notes (2026-06-17) — verified, then user-confirmed

- **Stagehand:** latest stable `@browserbasehq/stagehand@3.5.0` (npm `latest` tag; v3 is CDP-native, `@playwright/test` is an optional peer only). Integration = Stagehand owns the agent browser (DECISIONS #21). To pin at build: `@browserbasehq/stagehand`, the Vercel AI SDK (`ai`) + `@ai-sdk/anthropic` (and `@ai-sdk/openai`/`@ai-sdk/google`/`@ai-sdk/openai-compatible` for the other providers, defined but Anthropic is the one exercised now). Our `playwright@^1.61.0` stays for replay. Re-confirm exact versions with `npm view` at install.
- **Browser binary in Docker:** the `mcr.microsoft.com/playwright:v1.61.0-noble` base ships Chromium; point Stagehand's `localBrowserLaunchOptions` at it (`executablePath`/`channel`) so the agent path needs no extra browser install.
- **Model/test posture (DECISIONS #22):** agent (learn) tests target **Anthropic Claude Sonnet** (pin the exact AI-SDK model id, e.g. `anthropic/claude-sonnet-4-6`, at build), key via env `ANTHROPIC_API_KEY`, opt-in `npm run test:live`. Offline suite stays LLM-free: prove the **replay** half of the round-trip on a compiled/seeded playbook with no key; the **learn** half + provenance/action-only/guardrail agent tests run under `test:live`.
- **Scope (DECISIONS #22):** real-site learn+replay demo + token-cost note are **deferred** (carried-forward item) — done once a key/site is wired; fixture proves the mechanism this phase.
- **Open build-time risk (not a user decision):** compilation needs a selector-level recorded action stream. Verify at build whether Stagehand v3's autonomous `agent()` exposes per-action selectors/history cleanly, or whether the learn loop should orchestrate `observe()`→`act()` (which surface selectors) to capture a compilable stream. Resolve in code; record the chosen approach in Notes.
