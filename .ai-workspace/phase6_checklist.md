# Phase 6 — Transports & Storage Backends (webhooks, SQS, S3, modes) — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase6_plan.md](./phase6_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [ ] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full.
- [ ] Re-read [phase6_plan.md](./phase6_plan.md) and this checklist end to end.
- [ ] Re-read the referenced master sections: PROJECT_SPEC.md §4.2, §6 · ARCHITECTURE.md §8.3, §8.4.
- [ ] Confirm the **Phase 5 Plan & Verify gate actually passed** — don't trust the checkbox; spot-check that Phase 5's exit condition holds against the code as built (EXECUTION_STANDARDS §7).
- [ ] Reconcile the plan against the codebase **as actually built** — note any drift from earlier-phase assumptions.
- [ ] Verify library/API choices are still current (Stagehand, Playwright, Fastify, Anthropic SDK, pg, Zod) — pin versions in the plan's Notes.
- [ ] Surface every open question / ambiguity / trade-off to the user. Contract-affecting ambiguity is a STOP-and-ask.
- [ ] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. Only then execute.

---


Swap the local edges for production ones, and split the process roles. The core is unchanged — these are interchangeable adapters around it.

### Tasks

**Webhooks**
- [ ] `WebhookDispatcher`: POST the envelope to `callback_url`; HMAC-SHA256 sign over raw body (`X-Engine-Signature`, per-caller secret).
- [ ] Retry 3× with backoff on non-2xx; record `webhook_status` on the run.

**SQS (architecture §8 / spec §4.2)**
- [ ] `SqsConsumer`: same payload schema + orchestrator as HTTP; active when `SQS_ENABLED=true` and `SERVICE_MODE∈{worker,all}`.
- [ ] Visibility heartbeat extension for long agent runs; prefetch only up to free slots.
- [ ] DLQ (`SQS_DLQ_URL`) for poison messages; optional results queue (`SQS_RESULTS_QUEUE_URL`) publishing the envelope.
- [ ] At-least-once safety: idempotency + idempotent evidence/version writes make redelivery safe.

**S3 backends**
- [ ] `PlaybookStore` S3 impl (same layout/prefix as local).
- [ ] `EvidenceStore` S3 impl; envelope carries signed expiring URLs.
- [ ] `SelectorCache` S3 impl (local impl introduced with Stagehand in Phase 4).
- [ ] `evidence_inline` path for air-gapped local mode (base64 in envelope).

**Service modes**
- [ ] `SERVICE_MODE=api`: HTTP only — validate/persist/enqueue (requires SQS).
- [ ] `SERVICE_MODE=worker`: SQS consume + execute only.
- [ ] `SERVICE_MODE=all`: HTTP + in-process loop (unchanged from earlier phases).

### Acceptance criteria
- Webhook delivered with a valid signature a caller can verify; retried on a simulated 500; `webhook_status` recorded.
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
- [ ] Re-read this checklist top to bottom; confirm **every task box above is genuinely checked by observation**, not assumption. Un-check anything you can't personally confirm right now.
- [ ] Re-read the phase plan and the referenced `PROJECT_SPEC.md` / `ARCHITECTURE.md` sections; confirm what was built matches what they specify. Record any as-built drift in Notes and sync the master docs.
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
- [ ] Notes section below is filled (versions, deviations, warnings, carried-forward items) — an empty Notes is a red flag.
- [ ] `DECISIONS.md` updated for any user-confirmed decision made this phase (same commit).
- [ ] `PROJECT_CHECKLIST.md` status reflects reality (phase complete, next phase, blockers).
- [ ] Commit as `Phase 6: <summary>`.
- [ ] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7).

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

- Pinned versions:
- Deviations from plan (+ why):
- Benign warnings observed:
- Open items carried forward:
