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
| | | | | | |
