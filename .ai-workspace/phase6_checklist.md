# Phase 6 — Transports & Storage Backends (webhooks, SQS, S3, modes) — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase6_plan.md](./phase6_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [x] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full (re-read this session at the Phase 4/5 kickoffs; still in force).
- [x] Re-read [phase6_plan.md](./phase6_plan.md) and this checklist end to end.
- [x] Re-read the referenced master sections: PROJECT_SPEC.md §4.2, §6 · ARCHITECTURE.md §8.3 (topologies), §8.4 (reliability).
- [x] Confirm the **Phase 5 Plan & Verify gate actually passed** — verified this session: offline 74/3-skip, LIVE heal+fallback, in-Docker heal+fallback all green.
- [x] Reconcile the plan against the codebase **as actually built** — storage interfaces (`PlaybookStore`/`EvidenceStore`/`SelectorCache`) backend-agnostic + local-only (need S3 impls); `SERVICE_MODE` resolved but `index.ts` always serves HTTP; `runs.webhook_status` + `evidence_inline` flag exist but no dispatcher/SQS/S3 env keys; evidence URLs are engine-proxied today.
- [x] Verify library/API choices are still current — to add: **AWS SDK v3** `@aws-sdk/client-sqs` + `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (latest-stable, honor a custom endpoint for LocalStack). Stagehand/Playwright/Fastify/pg/Zod unchanged from Phase 5.
- [x] Surface every open question / ambiguity / trade-off to the user — 3 surfaced + answered: AWS emulation (LocalStack), webhook signing (deferred to Phase 7), evidence URLs (stable engine path → 302 to presigned). DECISIONS #29–#31.
- [x] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. — plan + checklist + DECISIONS updated; **awaiting explicit "start Phase 6" before any code.**

---


Swap the local edges for production ones, and split the process roles. The core is unchanged — these are interchangeable adapters around it.

### Tasks

**Webhooks** — `src/shared/webhook.ts`
- [x] `WebhookDispatcher`: POST the envelope to `callback_url`, **unsigned** (DECISIONS #30; HMAC lands with Phase-7 auth). — `HttpWebhookDispatcher`; delivered after the run settles via `deliverResults`.
- [x] Retry up to `WEBHOOK_MAX_RETRIES` with exponential backoff on non-2xx; record `webhook_status` (additive `meta` field). — `webhook.test.ts`: delivered → `delivered`; persistent 500 → retried → `failed`.

**SQS (architecture §8 / spec §4.2)** — `src/transport/sqs.ts` + `sqs-consumer.ts`
- [x] `SqsConsumer`: the SAME payload schema + orchestrator as HTTP (`executeFromQueue`); runs on `worker`/`all`, never `api`. — `sqs.test.ts` (api enqueues → worker consumes → completes) + cloud e2e.
- [x] Visibility heartbeat (`ChangeMessageVisibility` on a timer) for long runs; prefetch only up to free slots (`maxConcurrentRuns − inFlight`).
- [x] DLQ for poison messages (queue redrive policy, `maxReceiveCount`); optional results queue (`SqsResultsPublisher`). — `sqs.test.ts`: malformed message → DLQ.
- [x] At-least-once safety: idempotency-key dedup + a terminal-run redelivery guard + idempotent evidence/version writes. — `sqs.test.ts`: re-running a settled run doesn't re-execute (`finished_at` unchanged).

**S3 backends** — `store.s3.ts`, `evidence.s3.ts`, `cache/selector-cache.s3.ts`, `persistence/aws.ts`
- [x] `S3PlaybookStore` (same layout/prefix as local). — `s3-storage.test.ts` + `backend-swap.test.ts`.
- [x] `S3EvidenceStore`. Envelope keeps the **stable engine URL**; S3 mode **302s to a freshly-presigned URL** (DECISIONS #31). — `backend-swap.test.ts`: evidence route → 302 → presigned URL resolves.
- [x] `S3SelectorCache`. — `s3-storage.test.ts`.
- [ ] ~~`evidence_inline` path (base64 in envelope)~~ — **deferred** (air-gapped convenience; the `evidence_inline` config flag exists but the base64 path isn't wired). Not on the cloud-topology critical path; recorded in Notes.

**Service modes** — `src/index.ts` `SERVICE_MODE` switch
- [x] `SERVICE_MODE=api`: HTTP only — validate/persist(queued)/enqueue (requires `SQS_ENABLED`, errors at boot otherwise). — cloud e2e.
- [x] `SERVICE_MODE=worker`: SQS consume + execute (+ `/health`). — cloud e2e.
- [x] `SERVICE_MODE=all`: HTTP + in-process loop (unchanged; the standing tests still pass).

### Acceptance criteria
- Webhook delivered to `callback_url`; retried on a simulated 500; `webhook_status` recorded. ~~with a valid signature a caller can verify~~ **signature deferred to Phase 7 (DECISIONS #30).**
- SQS message with the same payload schema runs identically to the HTTP path; result delivered by webhook and/or results queue.
- Worker crash mid-run → message redelivered → no duplicate playbook/version/evidence (idempotency holds).
- Poison message lands in DLQ after max receives.
- S3 backends: playbooks + evidence round-trip; signed evidence URL resolves; switching `STORAGE_BACKEND` local↔s3 needs no code change.
- `api` + `worker` split works end-to-end against SQS + RDS-style Postgres + S3.

### ▣ Plan & Verify gate — Phase 6
- **Plan check:** Is the payload→envelope contract *byte-identical* across HTTP and SQS? Any divergence means two code paths to maintain — confirm one orchestrator serves both.
- **Verify (automated):** webhook signing/retry tests; SQS redelivery-idempotency test; DLQ test; S3 round-trip tests; a backend-swap test (same suite passes on local and S3).
- **Verify (manual):** run the `api`+`worker` topology locally (LocalStack or real AWS dev) end-to-end.
- **Exit condition:** the engine runs in its production shape (scaled, queue-fed, S3-backed) with the same behavior it had as a single local container.

## ▣ Phase Review & Verification (mandatory — do before declaring the phase done)

Run this section literally, in order. A phase is **not done** until every box here is checked. Per EXECUTION_STANDARDS §1.6 and §5, green unit tests do not prove the behavior is right — re-verify by observation.

### Re-verification (cold)
- [x] Re-read this checklist top to bottom; every box reflects observation (offline + LocalStack + dockerized cloud e2e).
- [x] Re-read the plan + `PROJECT_SPEC.md §4.2/§6` / `ARCHITECTURE.md §8.3/§8.4`; built matches spec. As-built: `webhook_status` added to `meta` (additive), env surface synced, `evidence_inline` deferred (Notes).
- [x] `npx tsc --noEmit` clean; `eslint .` clean.
- [x] Full suite green — **83 passed, 3 live-skipped**, twice in a row (stabilized by capping vitest `maxWorkers` — see Notes). Phase 3 isolation + Phase 4 round-trip still green inside it.
- [x] **Cold start (dockerized cloud topology):** `docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build postgres localstack fixture api worker`, then `scripts/docker-cloud-check.ts` → **api → SQS → worker → S3 e2e: PASS** (POST to the api task → enqueued → worker consumed + executed against the fixture with S3 storage → completed).

### Bug sweep
- [x] Walked the acceptance criteria + risks: contract-identical HTTP vs SQS (one `prepare`/orchestrator), redelivery-idempotency (terminal-run guard, verified), poison→DLQ (verified), backend-swap (replay on S3, verified), evidence 302→presigned (verified), webhook retry→failed (verified). **Found + fixed:** (1) `webhook_status` wasn't surfaced in the envelope (added to `meta`); (2) a parallel-load flake from oversubscribed Chromium (capped `maxWorkers='50%'`).
- [x] Defects fixed; full suite re-run green twice.
- [x] No regression — the big orchestrator refactor (`prepare`/`submitInline`/`submitEnqueue`/`executeFromQueue`) preserved Phase 3/4/5 behavior.
- [x] Contract intact: payload→`{meta,result}` is **byte-identical across HTTP and SQS** (same `prepare` + orchestrator). Statuses + §7 codes unchanged; `webhook_status` is additive `meta`.

### Standing regression gates (must stay green once their phase has landed)
- [x] Phase 3 isolation cross-contamination test — green (after the reservation/refactor changes).
- [x] Phase 4 learn→replay round-trip — green offline (compile→replay) + LIVE.

### Sign-off
- [x] Notes filled (versions, deviations, warnings, carried-forward).
- [x] `DECISIONS.md` — #29–#31 recorded at kickoff; no new user-decision this phase (additive `meta` + flake fix are as-built, in Notes).
- [x] `PROJECT_CHECKLIST.md` status reflects reality (Phase 6 complete; next Phase 7).
- [x] Commit as `Phase 6: <summary>`. — `Phase 6: transports & storage backends (webhooks, SQS, S3, api/worker)`.
- [x] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7). — stopped; awaiting explicit Phase 7 go-ahead.

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

**Kickoff (2026-06-17) — pre-build:**
- **Pinned versions (to install at build):** `@aws-sdk/client-sqs`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (latest-stable; `npm view` at install). LocalStack image for docker-compose. No other dep changes.
- **Decisions (DECISIONS #29–#31):** LocalStack for AWS emulation; **webhook signing deferred to Phase 7** (unsigned delivery + retry + `webhook_status` this phase); evidence URLs stay the stable engine path → 302 to presigned S3 in s3 mode.
- **Deviations from plan (+ why):** (1) webhook is **unsigned** this phase (#30) — relaxes the "valid signature" acceptance criterion, user-approved; (2) evidence URLs via engine 302-redirect, not direct presigned URLs in the envelope (#31) — keeps the contract uniform across backends.
- **New env surface (to define, env-only):** `SQS_ENABLED`, `SQS_QUEUE_URL`, `SQS_DLQ_URL`, `SQS_RESULTS_QUEUE_URL`, `SQS_VISIBILITY_TIMEOUT_SECONDS`, `AWS_REGION`, `AWS_ENDPOINT_URL`/`S3_ENDPOINT` (LocalStack), `S3_BUCKET`, `WEBHOOK_MAX_RETRIES`. `STORAGE_BACKEND=local|s3` already exists.
- **Open items carried forward:** webhook HMAC signing (Phase 7 + auth); per-caller secrets (needs caller identity).
- **Master-doc sync (do at gate):** ARCHITECTURE §8.3/§8.4 already describe the topology + reliability accurately; sync the as-built env surface + the evidence-redirect + webhook-unsigned note. PROJECT_SPEC §4.2 (SQS) matches.

**Build (2026-06-17) — as-built:**
- **Pinned versions:** `@aws-sdk/client-sqs` / `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` `^3.1071.0`. LocalStack `localstack/localstack:3`. No other dep changes.
- **New modules:** `persistence/aws.ts` (clients honoring `AWS_ENDPOINT_URL` → LocalStack/AWS), `playbooks/store.s3.ts`, `evidence/evidence.s3.ts`, `cache/selector-cache.s3.ts`, `shared/webhook.ts`, `transport/sqs.ts` (enqueuer + results publisher), `transport/sqs-consumer.ts`. `index.ts` rewritten for storage selection + `SERVICE_MODE` topology + SQS + webhook/results.
- **Orchestrator refactor:** `submit` → shared `prepare()` + `submitInline` (all) / `submitEnqueue` (api) / `executeFromQueue` (worker) + `dispatch`; result delivery (`deliverResults`: webhook + results-queue) runs after the run settles in both execution paths. Transport deps (`mode`/`webhook`/`results`/`enqueuer`) are optional so the test harnesses + `all` mode are unaffected.
- **SQS message** = `{ runId, payload }` (api-created run so the caller polls the exact run); a bare payload is also accepted (worker creates the run). `parseQueueMessage` tolerates both.
- **As-built deviations:** (1) `webhook_status` is now an additive `meta` field (the run's `webhook_status` column was surfaced); (2) `evidence_inline` base64 path **deferred** (config flag exists, not wired — air-gapped convenience, off the cloud-topology path); (3) webhook **unsigned** (#30); (4) evidence via engine **302→presigned** (#31).
- **Defects found + fixed:** `webhook_status` not in the envelope (added); a `runMigrations`-style parallel flake here was Chromium oversubscription under parallel test files → capped vitest `maxWorkers='50%'` (suite green twice after).
- **Verification:** offline `webhook.test.ts` (2) + `sqs.test.ts` (3: e2e/redelivery/DLQ) + `s3-storage.test.ts` (3) + `backend-swap.test.ts` (1, replay-on-S3 + 302); dockerized **cloud e2e** `scripts/docker-cloud-check.ts` (api→SQS→worker→S3) PASS.
- **Carried forward:** webhook HMAC signing (Phase 7 + auth); `evidence_inline` base64; per-caller secrets.
