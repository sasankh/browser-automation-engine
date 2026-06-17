# Phase 0 — Foundations & Decisions — Plan

> Status: **DRAFT**. Companion: [phase0_checklist.md](./phase0_checklist.md). Master refs: `PROJECT_SPEC.md` §17.

## Goal

Lock every input later phases depend on, so no phase stalls on an unanswered question. Phase 0 produces decisions and a repo, not running code.

## Design decisions to confirm / make

- **Locked already (spec §17):** TypeScript/Node 22; Postgres everywhere; structural-first extraction with surfaced LLM fallback; three-limit concurrency model. Re-confirm these still hold.
- **API auth mode (open):** `none` | `api_key` | `hmac`. Default `none` for first internal deploy; reserve `hmac` (KSig1-style) for parity with Kompliant. Record the choice in `DECISIONS.md`.
- **Sync mode (open):** `?wait=true` in or out for v1. Default **out** (async-only) — simpler timeout story.
- **Project name:** replaces the "engine" placeholder; drives package name, ID prefixes, image name.
- **ID scheme:** ULID or KSUID for `run_...` / `pb_...` (sortable, no coordination). Record prefix constants.

## Deliverables

- `DECISIONS.md` at repo root capturing the four resolved items + the recorded defaults for the open ones.
- Repo with license, CODEOWNERS, branch protection.
- A provisioned model-provider key/endpoint (Anthropic/OpenAI/Google or local Ollama) proven reachable from a throwaway container.
- 2–3 real public test sites chosen (lookup forms, no auth, no CAPTCHA) + intent to build the bundled fixture site in Phase 2.

## Edge cases / risks

- **Choosing test sites that CAPTCHA-wall or block datacenter IPs** — vet them now; a site that needs a proxy isn't a good Phase-2/4 baseline. Note proxy-needing sites separately for later.
- **Name churn** — picking the name late forces a rename across package/IDs/image. Decide here.
- **Auth deferral risk** — `none` is fine for an internal first deploy but must be a conscious, recorded decision, not a default that silently ships to anything public.

## Exit

A second person could clone the repo and start Phase 1 with no verbal context. `DECISIONS.md` exists and is reviewed; the API key works from a container.
