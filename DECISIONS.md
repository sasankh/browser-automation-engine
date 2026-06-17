# DECISIONS

> Append-only log of every resolved decision: what, when, why. Newest at the bottom. One row per decision; never edit a past row — supersede it with a new one that references it.
>
> Per `EXECUTION_STANDARDS.md` §6, every user-confirmed decision is appended here in the same commit that acts on it. Open items live in `PROJECT_SPEC.md` §17 until resolved, then graduate to a row here.

## Locked (pre-code)

| # | Date | Decision | Rationale | Supersedes |
|---|---|---|---|---|
| 1 | 2026-06 | **Runtime: TypeScript / Node 22** | Stagehand is TS-native (the Python port lags); matches the Kompliant MCP-server stack; the AI sits behind the Claude API so there's no ML-library pull toward Python. | — |
| 2 | 2026-06 | **Store: PostgreSQL everywhere** for run records + playbook index | One mental model across local and cloud; transactional `active_version` pointer moves; matches existing Postgres expertise. Playbook *bodies* and evidence stay as blobs in local FS / S3. | — |
| 3 | 2026-06 | **Replay extraction: structural-first with a surfaced, config-gated LLM fallback** | Resilience to minor layout shifts without a full heal, but never a silent rescue — `meta.llm_fallback_used` + per-playbook counting keep drift visible. | — |
| 4 | 2026-06 | **Concurrency: three per-container limits** (`MAX_CONCURRENT_RUNS` / `MAX_QUEUE_DEPTH` / `RUN_TIMEOUT_SECONDS`) + full request-isolation invariants | Separates resource gating, backpressure, and stuck-run recovery — conflating them causes OOM or silent drops. Global cross-container cap deferred to v2. | — |
| 5 | 2026-06 | **Playbooks are declarative JSON ops, interpreted — never generated code** | Safety (no `eval` of LLM output), diffable across versions, exact provenance-based parameterization, portable. Cost: an op vocabulary to maintain. | — |

## Recorded defaults (open in spec §17, defaulted so Phase 1 isn't blocked — confirm or change at Phase 0)

| # | Date | Question | Recorded default | Notes |
|---|---|---|---|---|
| D1 | 2026-06 | API auth mode for v1 | `none` (internal network trust) for first deploy; `hmac` (KSig1-style) reserved | Must be a conscious decision before anything public-facing. |
| D2 | 2026-06 | Synchronous `?wait=true` mode | **out** for v1 (async-only) | Revisit if callers need fast inline playbook replays. |
| D3 | 2026-06 | Project name | TBD — replaces "engine" placeholder | Blocks package name, ID prefixes, image name. Decide at Phase 0. |
| D4 | 2026-06 | ID scheme | ULID/KSUID, prefixed `run_` / `pb_` | Sortable, no coordination. |

## Resolved during build

> (Append rows here as phases resolve open questions or make as-built decisions.)

| # | Date | Decision | Rationale | Phase | Supersedes |
|---|---|---|---|---|---|
| 6 | 2026-06-16 | **Project name: `Rote`** — replaces the "engine" placeholder | "Learn once, replay by rote" captures the two-speed thesis; short, clean package/Docker-image name. Sets package name + image name; ID prefixes stay semantic (`run_`, `pb_`), unaffected by the name. | 0 | D3 |
| 7 | 2026-06-16 | **API auth v1: `none`** (internal-network trust); `hmac` reserved | Conscious choice for the first internal-only deploy; `AuthGuard` is a pass-through until then. MUST be revisited before any public-facing deploy. | 0 | D1 |
| 8 | 2026-06-16 | **Sync mode: out** (async-only) for v1 | `POST /v1/runs` always returns `202`; results via webhook/poll. Simpler timeout + concurrency story. Revisit if callers need fast inline replays. | 0 | D2 |
| 9 | 2026-06-16 | **ID scheme: ULID**, prefixed `run_` / `pb_` | Lexicographically sortable, coordination-free, mature TS libraries; concrete ULID library chosen at Phase 1 (`ulidx`). | 0 | D4 |
| 10 | 2026-06-16 | **Dependency policy: pin latest-stable for every directly-declared package; latest-LTS Node** — verified at install and re-checked at every phase kickoff. Exceptions (documented): `@types/node` tracks the runtime Node major (not absolute latest); `playwright` npm is kept in lockstep with the `mcr.microsoft.com/playwright` image tag; versions nested *inside* Stagehand (its pinned `@anthropic-ai/sdk`, `pino`, `ai`, `openai`) are owned by Stagehand, not force-upgraded. | User directive: avoid the common AI-coding drift to stale versions. Latest **stable** only (never pre-release); pinned in `package.json` + lockfile for reproducibility; an automated currency check (Renovate/Dependabot or `npm outdated` in CI) can enforce it over time. Updates the "Node 22" part of #1 toward latest LTS — exact Node finalized at Phase 1 against the Node baked into the pinned Playwright image. | 0 | refines #1 |
| 11 | 2026-06-16 | **Model layer: provider-agnostic gateway** (refines #1's "AI sits behind the Claude API" framing — Anthropic is now one provider among several, not assumed). Day-one providers **Anthropic + OpenAI + Ollama/local + Google** via one `ModelGateway` on the Vercel AI SDK (`@ai-sdk/anthropic`/`openai`/`google`/`openai-compatible`), used by both the agent (Phase 4) and the surfaced replay fallback (Phase 5). Model chosen by a single **`model` string `provider/name`** (e.g. `openai/gpt-4.1`, `ollama/llama3.1`). **No built-in default — `model` is required** (`payload.config.model` > env `CONFIG_MODEL`); a run that needs a model with none set → `validation_error`. Provider/model selection is payload-overridable *behavior*; per-provider keys + endpoints (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OLLAMA_BASE_URL`) are **env-only**. | User directive: no single-provider lock-in, and the engine must never silently pick a provider/model (cost + independence control). Replay stays zero-LLM regardless. Response contract (envelope/status/errors) **unchanged** — only `model` *config semantics* change. | 0 | refines #1 |
| 12 | 2026-06-16 | **Phase 1 stub uses `internal_error`, not `not_implemented`** — the skeleton's stubbed `POST /v1/runs` marks the run `failed` with `error.code: internal_error` + message "execution not implemented (Phase 1 skeleton)". `not_implemented` is deliberately **not** added to the spec §7 error-code set. | Keeps the locked error-code contract unchanged; the stub is transient (gone once Phase 4 execution lands). The phase-1 docs' `not_implemented` wording was a drift caught at kickoff. | 1 | — |
| 13 | 2026-06-16 | **`meta.effective_config` echoes resolved overridable behavior keys only** — self-heal flags, `model`, `run_timeout_seconds`, `agent_max_steps`, evidence/proxy/headless/offsite, fallback flags. Excludes secrets, destinations, and per-container capacity limits (the latter visible via `/v1/health`). | Clarifies the envelope contract: `effective_config` is the per-run behavior config, not container capacity or secrets. | 1 | — |
| 14 | 2026-06-16 | **`extract` op carries a `fields` map** (`output_format` field → selector relative to `scope_selector`); the structural extractor reads it deterministically (no per-field heuristics). Extends the op vocabulary (`DATA_MODEL.md` §4). | Structural extraction needs a field→element mapping; the documented op only had `scope_selector`. The mapping is **agent-determined on the first run (Phase 4) and compiled into the playbook**; hand-authored in Phase 2 fixtures. The two-speed thesis applied to extraction — the runner stays a deterministic reader. | 2 | — |
| 15 | 2026-06-17 | **`runs.result` column added** (migration `0002_run_result.sql`) to persist the extracted result. | `DATA_MODEL.md` §2 omitted `result`, but `GET /v1/runs/{id}` must return it on poll (the envelope's `result`). As-built schema correction; synced into `DATA_MODEL.md` §2 + `ARCHITECTURE.md` §5.1. | 2 | — |
| 16 | 2026-06-17 | **Compose Postgres host port → `5433`** (was 5432) to avoid clashing with a developer's local Postgres; the engine still connects in-network via `postgres:5432`. | A host Postgres on 5432 shadowed the container for host-side connections (integration tests/migrate). Host-only change; the cold-start gate is unaffected. | 2 | — |
