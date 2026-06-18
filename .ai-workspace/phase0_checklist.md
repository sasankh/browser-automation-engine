# Phase 0 — Foundations & Decisions — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase0_plan.md](./phase0_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [x] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full.
- [x] Re-read [phase0_plan.md](./phase0_plan.md) and this checklist end to end.
- [x] Re-read the referenced master sections: PROJECT_SPEC.md §17 (resolved decisions + open questions).

- [x] Reconcile the plan against the codebase **as actually built** — note any drift from earlier-phase assumptions.
- [x] Verify library/API choices are still current (Stagehand, Playwright, Fastify, Anthropic SDK, pg, Zod) — pin versions in the plan's Notes.
- [x] Surface every open question / ambiguity / trade-off to the user. Contract-affecting ambiguity is a STOP-and-ask.
- [x] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. Only then execute.

---


Lock the inputs so no later phase stalls on an unanswered question.

### Tasks
- [x] Confirm locked decisions from spec §17: TypeScript/Node 22, Postgres everywhere, structural-first extraction with surfaced LLM fallback, three-limit concurrency model.
- [x] Decide **API auth mode** for v1 (`none` | `api_key` | `hmac`). Default assumption: `none` for first internal deploy, `hmac` reserved. Record the choice. → **`none`** (DECISIONS.md #7).
- [x] Decide **sync mode** (`?wait=true`) in or out for v1. Default: out (async-only). → **out** (DECISIONS.md #8).
- [x] Pick the **project name** (replaces "engine" placeholder) — affects package name, ID prefixes, image name. → **Rote** (DECISIONS.md #6).
- [ ] Provision a **model-provider key/endpoint** (Anthropic/OpenAI/Google or local Ollama) and confirm Stagehand can reach it from a local container. → **DEFERRED to Phase 4** (see Notes — secret not handled in chat; not needed until the agent path).
- [ ] Confirm **target test sites**: pick 2–3 real public sites with lookup forms for end-to-end validation (no auth, no CAPTCHA) + the bundled fixture site. → **PROVISIONAL candidates recorded; vet at Phase 2** (see Notes).
- [ ] Repository created; license; CODEOWNERS; branch protection. → repo ✓ exists; **license / CODEOWNERS / branch protection pending user input** (see Notes).
- [x] Decide ID scheme: `run_...`, `pb_...` (ULID/KSUID for sortability). Record prefix constants. → **ULID**, prefixes `run_` / `pb_` (DECISIONS.md #9).

### Acceptance criteria
- All four spec §17 "resolved" items are reflected in a short `DECISIONS.md` in the repo.
- The three still-open-but-non-blocking questions have a recorded default so Phase 1 can proceed.

### ▣ Plan & Verify gate — Phase 0
- **Plan check:** Is every input Phase 1 needs now decided or defaulted? (runtime, DB, auth, name, IDs, API key, test sites)
- **Verify:** `DECISIONS.md` exists and is reviewed. A model-provider key/endpoint works from a throwaway container (`curl` the provider API or a 3-line Stagehand smoke). No open question blocks scaffolding.
- **Exit condition:** a second person could start Phase 1 from the repo with no verbal context.

## ▣ Phase Review & Verification (mandatory — do before declaring the phase done)

Run this section literally, in order. A phase is **not done** until every box here is checked. Per EXECUTION_STANDARDS §1.6 and §5, green unit tests do not prove the behavior is right — re-verify by observation.

> **Phase 0 is decisions-only (no source code).** The code-verification items below (`tsc`, test suite, cold-start docker, input-fuzzing bug sweep) are **N/A this phase**; the re-read / doc-sync and sign-off items apply and are done by observation.

### Re-verification (cold)
- [x] Re-read this checklist top to bottom; confirm **every task box above is genuinely checked by observation**, not assumption. Un-check anything you can't personally confirm right now.
- [x] Re-read the phase plan and the referenced `PROJECT_SPEC.md` / `ARCHITECTURE.md` sections; confirm what was built matches what they specify. Record any as-built drift in Notes and sync the master docs. *(Reconciled SPEC/ARCH + 6 other docs for the provider-agnostic model gateway + Node 24; contract unchanged.)*
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
- [x] Notes section below is filled (versions, deviations, warnings, carried-forward items) — an empty Notes is a red flag.
- [x] `DECISIONS.md` updated for any user-confirmed decision made this phase (same commit) — rows #6–#11.
- [x] `PROJECT_CHECKLIST.md` status reflects reality (Phase 0 task boxes checked; Phase 1 next).
- [x] Commit as `Phase 0: <summary>`.
- [x] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7).

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

**Status (2026-06-16):** Full foundational decision slate confirmed (name, auth, sync, IDs, dependency policy, no-LangChain, provider-agnostic model layer, license). Master docs reconciled for the model-gateway refinement. Plan approved; committing as `Phase 0: foundations & decisions`. CODEOWNERS + branch protection deferred as non-blocking.

**Confirmed decisions (recorded in `DECISIONS.md` rows 6–11):**
- Project name: **Rote** (replaces "engine"). Drives package name + Docker image name. ID prefixes stay semantic (`run_`, `pb_`).
- API auth v1: **none** (internal-network trust); `hmac` reserved. `AuthGuard` is a pass-through until a public-facing deploy — revisit before then.
- Sync mode: **out** (async-only). `POST /v1/runs` always returns `202`.
- ID scheme: **ULID** (lib `ulidx`), prefixed `run_`/`pb_`.
- Dependency policy: **latest-stable everywhere** (#10) — full pinned table below.
- **No LangChain** — Stagehand → Vercel AI SDK; deterministic replay; Zod extraction. (Verified absent from Stagehand's dep tree; definitive `npm ls langchain` post-install at Phase 1.)
- **Model layer: provider-agnostic gateway** (#11) — Anthropic + OpenAI + Ollama/local + Google via one `ModelGateway` on the Vercel AI SDK; model = single `provider/name` string; **require explicit `model`, no built-in default** (missing-and-needed → `validation_error`); per-provider keys/endpoints env-only.
- **License: `UNLICENSED`/private** — implemented via `package.json` (`"license": "UNLICENSED"`, `"private": true`) at Phase 1; no LICENSE file authored on a guessed copyright holder.
- The four "locked" decisions (TS/Node — now **Node 24 LTS** per #10, Postgres everywhere, structural-first + surfaced LLM fallback, three-limit concurrency) re-confirmed intact.

**Doc reconciliation (this commit):** generalized the Anthropic-only model prose to the provider-agnostic gateway and bumped Node 22→24 across `PROJECT_SPEC.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `EXECUTION_STANDARDS.md` (layering invariant), `LOCAL_DEV.md`, `SECURITY.md`, `API_REFERENCE.md`, `TESTING_STRATEGY.md`, and the Phase 1/4 task lines. **Response contract (envelope/statuses/error codes) left byte-for-byte unchanged.** Deferred: the Phase 4 working docs and the generic "verify currency (… Anthropic SDK …)" list-lines still read Anthropic-centric — reconcile at the Phase 4 kickoff.

**Latest-stable versions — full anticipated dependency set (verified 2026-06-16 via `npm view`; policy in DECISIONS.md #10).** Pin these (latest **stable**, never pre-release) in `package.json` + lockfile at Phase 1; re-verify at every kickoff.

_Runtime (direct):_

| Package | Latest | Notes |
|---|---|---|
| `fastify` | 5.8.5 | HTTP server (v5). |
| `@fastify/helmet` | 13.0.2 | Security headers (Phase 7; optional). |
| `zod` | 4.4.3 | **Zod 4.x** — payload schema + `output_format`→Zod (Phases 1/4) use the v4 API. Satisfies Stagehand's `zod ^4.2.0` peer. |
| `pino` | 10.3.1 | Logger (v10). Stagehand nests its own `pino@^9` — separate copy, fine. |
| `pino-pretty` | 13.1.3 | Dev log formatting. |
| `pg` | 8.21.0 | Postgres client. |
| `node-pg-migrate` | 8.0.4 | Migration tool (confirm at Phase 1). |
| `@browserbasehq/stagehand` | 3.5.0 | **Major beyond docs' API** — re-verify `agent/act/observe/extract` at Phase 4. Peers: `playwright-core ^1.55.1` (✓ by 1.61.0), `zod ^4.2.0` (✓). Nests `@anthropic-ai/sdk@0.39.0`, `ai@5`, `openai@4`. Confirm `puppeteer-core`/`patchright-core` peers are optional (we use the Playwright driver). |
| `playwright` | 1.61.0 | **Lockstep with the Playwright Docker image tag** (`:v1.61.0-…`). Satisfies Stagehand's `playwright-core ^1.55.1`. |
| `@anthropic-ai/sdk` | 0.104.2 | Our direct agent/fallback client (Phases 4/5). Distinct from Stagehand's nested `0.39.0`. |
| `ulidx` | 2.4.1 | Chosen over `ulid@3.0.2` — TS-first, monotonic factory. ID scheme = ULID (#9). |
| `@aws-sdk/client-sqs` | 3.1070.0 | Phase 6. |
| `@aws-sdk/client-s3` | 3.1070.0 | Phase 6. |
| `@aws-sdk/s3-request-presigner` | 3.1070.0 | Signed evidence URLs (Phase 6). |
| `prom-client` | 15.1.3 | Metrics (Phase 7). |
| `dotenv` | 17.4.2 | Local env loading. |
| `undici` | 8.5.0 | Only if needed — Node 24 has global `fetch`; likely omit. |

_Toolchain / dev:_

| Package | Latest | Notes |
|---|---|---|
| `typescript` | 6.0.3 | **TS 6** — within typescript-eslint peer (`>=4.8.4 <6.1.0` ✓). |
| `@types/node` | 24.x | **Exception: match the runtime Node major, NOT the newest published (25.x).** |
| `@types/pg` | 8.20.0 | |
| `vitest` | 4.1.9 | Test runner (v4). |
| `@vitest/coverage-v8` | 4.1.9 | Lockstep with vitest. |
| `eslint` | 10.5.0 | **ESLint 10** (flat config). Engines: Node `^22.13` / `>=24`. Within typescript-eslint peer (`^10.0.0` ✓). |
| `typescript-eslint` | 8.61.1 | Flat-config meta package; co-installs cleanly with TS 6 + ESLint 10. |
| `prettier` | 3.8.4 | |
| `tsx` | 4.22.4 | Dev TS runner. |

_Fixture site (Phase 2):_

| Package | Latest | Notes |
|---|---|---|
| `express` | 5.2.1 | Express 5. |
| `@types/express` | 5.0.6 | Matches express 5. |

**Compatibility verified at latest (no peer conflicts among the constraining set):** TS 6.0.3, ESLint 10, and `playwright@1.61.0` all satisfy their peers; every package's `engines` is satisfied by Node 24 (and Node ≥22.13).

**Node runtime:** target **latest LTS = Node 24** (supersedes the docs' Node 22 toward "latest"; exact pin set at Phase 1 against the Node baked into the pinned Playwright image — Stagehand needs `^20.19 || >=22.12`, ESLint 10 needs `^22.13 || >=24`, so Node 24 clears everything). `@types/node` follows the major we land on. Master docs (`ARCHITECTURE.md`, CLAUDE.md) still say Node 22 — reconcile at Phase 1 once the image's Node is confirmed.

**"Latest" exceptions (blind-latest is wrong here) — DECISIONS.md #10:**
1. `@types/node` tracks the runtime Node major, not the newest published (25.x).
2. `playwright` npm ⇄ `mcr.microsoft.com/playwright` image tag move together.
3. Stagehand owns its nested deps (pinned `@anthropic-ai/sdk@0.39.0`, `pino@9`, `ai@5`, `openai@4`); can't force those to latest without forking — our *direct* deps are latest and resolve alongside.

**Reconciliation vs as-built:** No source code, no `package.json`, empty `.gitignore`, single commit (`initial plan and commit`). Branches: `phase-0` (current), `develop`, both on `origin`. No drift to reconcile — nothing is built yet.

**Deviations from plan (+ why):**
- **Anthropic API-key smoke test deferred to Phase 4.** A secret must not be pasted into chat or committed; `ANTHROPIC_API_KEY` is env/secret-manager only. It's first exercised in Phase 4 (no browser/LLM in Phases 1–3), so reachability verification carries to the Phase 4 kickoff. Recommend the user run a throwaway `curl https://api.anthropic.com/v1/messages` (or a 3-line Stagehand smoke) from a container before then.
- **Test sites recorded as provisional, to be vetted at Phase 2** (when the runner exists to actually test them). Candidates (public lookup forms, no auth, no CAPTCHA, datacenter-IP-tolerant): **FCC ULS License Search**, **SEC EDGAR company search**, **NPI Registry provider lookup**. The bundled fixture site (Phase 2) remains the primary offline target. User may substitute domain-specific targets (e.g., state professional-license boards).

**Benign warnings / flags:**
- Stagehand 3.x and Zod 4.x are majors ahead of the prose — flagged above; not blocking Phase 0 (no code), but load-bearing at Phases 1/4.

**Open items carried forward (gate the Phase 0 *closeout*, NOT Phase 1 scaffolding):**
- [x] License → **`UNLICENSED`/private**, implemented in `package.json` at Phase 1 (decided 2026-06-16).
- [ ] `.github/CODEOWNERS` — needs the real GitHub owner handle(s)/team (deferred, non-blocking).
- [ ] Branch protection on `develop` / `main` — GitHub admin operation (deferred; user applies or I provide `gh` commands).
- [ ] Provider key/endpoint reachability (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OLLAMA_BASE_URL`) — verify before Phase 4.
- [ ] Test-site confirmation — vet provisional candidates at Phase 2.
- [ ] Phase 4 working-doc reconciliation (model layer Anthropic→gateway) — at the Phase 4 kickoff.

> Phase 1 (skeleton — API/config/Postgres/envelope/Docker; no browser, no LLM) is fully **unblocked** by the confirmed decisions above. The carried-forward items gate the Phase 0 closeout, not the Phase 1 start.
