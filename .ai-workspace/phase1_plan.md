# Phase 1 — Skeleton — Plan

> Status: **DRAFT**. Companion: [phase1_checklist.md](./phase1_checklist.md). Master refs: `PROJECT_SPEC.md` §4–§7, §10, §12 · `ARCHITECTURE.md` §5.1, §10, §12.

## Goal

A running service that accepts a run, persists it, and returns a valid `{meta, result}` envelope — **with no browser yet**. This phase proves the public contract and the plumbing in isolation, so every later phase adds behavior behind an unchanged surface.

## Design decisions

- **Fastify** as the HTTP layer; **pino** for structured `run_id`-scoped logs.
- **Zod** as the single source of truth for the payload schema; the inferred type is the payload type used everywhere (no hand-written duplicate).
- **Postgres** via a thin query layer (`pg` + a migration tool, e.g. `node-pg-migrate`). No ORM — the schema is small and the `active_version` transaction wants explicit SQL.
- **Execution is stubbed** this phase: `POST /v1/runs` persists `queued` and the (stub) worker immediately marks the run `failed` with a `not_implemented` error code, OR returns a canned envelope. Pick one, record it in Notes. The point is to exercise persistence + envelope, not behavior.
- Config via the `ConfigResolver` from day one, even though few keys are enforced yet — so later phases never retrofit `process.env` reads.

## File-by-file (indicative, per ARCHITECTURE §12)

- `src/transport/http-server.ts` — Fastify bootstrap, route registration, error→envelope mapping.
- `src/transport/routes/runs.ts`, `routes/health.ts` — `POST /v1/runs`, `GET /v1/runs/:id`, `GET /v1/health`.
- `src/intake/payload-schema.ts` — Zod schema (spec §5) + resolution-precondition refinement.
- `src/intake/config-resolver.ts` — pure per-key merge (spec §10); returns a frozen config.
- `src/intake/idempotency.ts` — `(caller, idempotency_key)` lookup/insert.
- `src/persistence/runs/run-store.pg.ts` — create/update run rows, status transitions.
- `src/shared/envelope.ts` — build `{meta, result}`; enforce `result` = caller-shape-or-null.
- `src/shared/ids.ts` — ULID/KSUID prefixed IDs.
- `src/types/*` — payload, envelope, run, status/error enums.
- `migrations/0001_init.sql` — `playbooks`, `playbook_versions`, `runs`, `idempotency_keys` (ARCHITECTURE §5.1).
- `Dockerfile`, `docker-compose.yml` (engine + Postgres).

## Edge cases

- Malformed payload → `validation_error`, **no** run row created (validate before persist).
- Neither `playbook_id` nor `instruction`+`url` present → `validation_error` (resolution precondition).
- Repeat `idempotency_key` → same `run_id`, same envelope, no second row.
- `effective_config` must reflect payload-over-env-over-default for a probe key, and must **ignore** payload attempts to set env-only keys (capacity/destination) — log at debug.

## Risks

- **Contract drift starts here.** Any divergence of the payload/envelope/status/error types from spec §5–§7 is cheapest to fix now. The gate's plan-check is specifically about this.
- **Migration hygiene** — `0001_init.sql` must run clean on an empty DB and match the DDL the later phases assume (especially `active_version`, `playbook_versions`, idempotency unique constraint).

## Exit

`docker compose up` is healthy; the accept/reject/idempotency/effective-config scenarios pass by observation; unit suite + image build green in CI. The service is a faithful, testable shell of the final contract.
