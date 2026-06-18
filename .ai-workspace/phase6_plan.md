# Phase 6 — Transports & Storage Backends — Plan

> Status: **DRAFT**. Companion: [phase6_checklist.md](./phase6_checklist.md). Master refs: `PROJECT_SPEC.md` §4.2, §6 · `ARCHITECTURE.md` §8.3, §8.4.

## Goal

Swap the local edges for production ones and split the process roles. The core built in Phases 1–5 is unchanged — webhooks, SQS, and S3 are interchangeable adapters around it, and the `api`/`worker` split is the same image with a different `SERVICE_MODE`.

## Design decisions

- **One orchestrator, two transports.** The SQS consumer and the HTTP handler share the exact same payload schema and orchestrator. The gate's plan-check requires the payload→envelope contract to be **byte-identical** across both — any divergence means two code paths to maintain.
- **At-least-once + idempotent effects**, not exactly-once. SQS redelivery on worker crash is safe because run creation is idempotency-keyed and evidence/version writes are idempotent on `run_id`/`(playbook_id, version)`.
- **Storage behind interfaces.** `PlaybookStore`/`EvidenceStore`/`SelectorCache` get S3 impls with the same layout/prefix as local; switching `STORAGE_BACKEND` local↔s3 needs **no** code change above persistence (EXECUTION_STANDARDS §3 layering). **AWS SDK v3 honors a custom endpoint → LocalStack in dev, real AWS in prod** (DECISIONS #29). Evidence URLs stay the stable engine path `/v1/runs/:id/evidence/:file` in all backends; S3 mode 302-redirects to a freshly-presigned URL (DECISIONS #31).
- **Webhooks are delivered UNSIGNED this phase** (POST + retry + `webhook_status`); HMAC `X-Engine-Signature` signing is **deferred to Phase 7 with auth** (no caller identity in v1 to key a per-caller secret — DECISIONS #30).

## File-by-file (indicative)

- `src/shared/webhook.ts` — sign over raw body, POST, retry 3× backoff, record `webhook_status`.
- `src/transport/sqs-consumer.ts` — long-poll; same orchestrator; visibility heartbeat for long agent runs; prefetch only up to free slots; DLQ; optional results-queue publish.
- `src/persistence/playbooks/store.s3.ts`, `evidence/evidence.s3.ts`, `cache/selector-cache.ts` (S3 impl) — signed expiring URLs for evidence.
- Entrypoint `SERVICE_MODE` switch: `api` (HTTP validate/persist/enqueue), `worker` (consume/execute), `all` (unchanged).
- `evidence_inline` path for air-gapped local mode (base64 in envelope).

## Edge cases / risks

- **Contract drift between transports** — the single biggest risk; one schema, one orchestrator, golden envelope fixtures shared across both.
- **Redelivery duplicates** — worker crash mid-run must not create a duplicate playbook/version/evidence; verify idempotency holds.
- **Poison messages** — land in DLQ after max receives, not an infinite redelivery loop.
- **Backend-swap regressions** — the same integration suite must pass on both local and S3 (a backend-swap test).
- **Visibility timeout vs run timeout** — visibility must exceed `RUN_TIMEOUT_SECONDS` with heartbeat margin, or a long agent run gets redelivered mid-flight.

## Exit

The engine runs in its production shape (scaled, queue-fed, S3-backed) with the same behavior it had as a single local container: webhook signed/retried/recorded; SQS path identical to HTTP; redelivery-idempotency holds; DLQ works; S3 round-trips; `api`+`worker` split runs end-to-end (LocalStack or AWS dev).
