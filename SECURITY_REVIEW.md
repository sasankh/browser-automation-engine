# Security Review (v1)

> **Status: self-review by the implementer.** Per DECISIONS #33, this is an adversarial walk of the
> threat surface, written for an **independent sign-off** (a second set of eyes / `/security-review`) —
> it is **not** itself an independent attestation. Each item lists the control, where it lives, and the
> automated test that proves it. Reviewer: confirm each, then sign off below.

Scope note (DECISIONS #32): the engine is deployed **behind a trusted gateway** that terminates caller
auth and webhook verification. API auth, API keys, and webhook signing are therefore **out of scope for
the engine** (`API_AUTH_MODE=none`). This review covers what the engine owns itself.

## Threat: SSRF — the browser as a confused deputy

The engine drives a real browser to caller-influenced URLs; without guards a caller (or a tampered
playbook) could reach cloud metadata (`169.254.169.254`), internal services, or loopback.

- **Control:** `assertAllowedUrl` (`src/browser/ssrf-guard.ts`) denies RFC1918 / `127/8` / `169.254/16`
  link-local+metadata / `100.64/10` CGNAT / IPv6 ULA+loopback / `*.internal`/`*.local`/`localhost`, and
  non-`http(s)` schemes. Deliberate internal targets opt in via `ALLOWED_PRIVATE_CIDRS` (CIDR allowlist);
  `ALLOW_PRIVATE_TARGETS=true` permits all private (dev only).
- **Applied at all three surfaces:** the initial `url` and every **agent navigation**
  (`agent-engine.ts`, incl. off-site registrable-domain confinement unless `allow_offsite`), **and the
  replay `goto` pre-flight** (`RunOrchestrator.replayTargetBlocked` — a stored playbook is never trusted
  to only point at public hosts → `navigation_failed`).
- **Tests:** `test/unit/ssrf-guard.test.ts` (deny set, CIDR allowlist precision, scheme/malformed),
  `test/integration/security.test.ts` (metadata-IP + private-IP replay `goto` → `navigation_failed`).
- **Residual risk:** literal-host checks only — a **public DNS name that resolves to a private IP**
  (rebinding) is not blocked at resolution time (documented limitation; mitigate with network-layer
  egress rules in the container/VPC). No SSRF check on outbound **webhook** `callback_url` (trusted-gateway
  posture). Both are reviewer call-outs.

## Threat: data exfiltration — sensitive `data` leaking out

`data` values can be SSNs, license numbers, names. They must not persist or get logged in the clear.

- **Logs:** the structured logger redacts the `data` object by path (`src/shared/logger.ts`), and a
  free-text `Redactor` (`src/shared/redactor.ts`) masks values in Stagehand log lines (the typed-into-field
  text). Verified by an **automated no-leak scan** that captures stdout during a run.
- **Run rows:** store data **keys**, not values, by default (`createRun` → `data_keys`); raw values are
  only written when `STORE_RUN_INPUTS=true` (off by default, `data_values` column).
- **Playbook bodies:** hold only `{{data.*}}` refs — guaranteed by **provenance-by-value-identity**
  templating (Phase 4), never a page-text scan, so a value is never baked into a body.
- **Secrets:** provider keys / DB creds / webhook secrets / proxy creds are **env / secret-manager only**
  (`ModelGateway` resolves keys from env; payloads can pick a provider but never supply a secret).
- **Tests:** `test/integration/security.test.ts` no-leak scan asserts a sentinel value appears in
  **none** of: captured logs, the raw run row, the playbook body. `test/unit/redactor.test.ts`,
  `test/unit/compiler.test.ts` / `provenance.test.ts` (only typed values templated).
- **Residual risk:** `STORE_RUN_INPUTS=true` intentionally stores values (debug opt-in — document/limit).
  Evidence (`page.html`/screenshot) captures the rendered results page, which by design contains the
  *extracted* data — protect evidence storage + set retention accordingly.

## Threat: code execution from learned artifacts

The agent's output is data; if any of it were executed, a compromised site could run code in the engine.

- **Control:** a playbook is declarative JSON interpreted by a **fixed op vocabulary** (`playbook-schema.ts`
  strict Zod enum). Nothing from a body is `eval`'d / `Function()`'d. Adding a capability extends the
  interpreter, never embeds code.
- **Tests:** `test/integration/security.test.ts` — the schema rejects an off-vocabulary `op`, and the
  replay interpreter sources (`runner.ts`, `step-interpreter.ts`, `structural-extractor.ts`) contain no
  `eval(` / `new Function(`.

## Threat: resource exhaustion / DoS

- **Controls:** per-container `MAX_CONCURRENT_RUNS` semaphore, `MAX_QUEUE_DEPTH` bounded waiting room →
  `429` + `Retry-After`, per-run `RUN_TIMEOUT_SECONDS` wall clock (wedged run killed, slot reclaimed),
  `BROWSER_RECYCLE_RUNS` memory hygiene, boot-time memory budget warning. SQS absorbs bursts in the
  scaled topology; CAPTCHA short-circuits (`captcha_detected`) rather than spinning.
- **Tests:** Phase 3 `concurrency.test.ts` (isolation @600 concurrent, cap, backpressure, timeout→slot
  reclaim, drain); Phase 6 `sqs.test.ts` (DLQ for poison messages).

## Threat: cross-request contamination (multi-tenant-ish)

- **Control:** **one Playwright `BrowserContext` per run**, created at start, closed at end; never a
  pooled/reused `Page`/`BrowserContext`/Stagehand instance; no module-level mutable run state. The
  Chromium **process** is shared (cheap startup), contexts never are.
- **Test:** the release-blocking isolation test — N concurrent runs each see only their own cookie +
  localStorage, at high repetition (`concurrency.test.ts`).

## Threat: redelivery / replay duplication (SQS)

- **Control:** at-least-once + idempotent effects — idempotency-key dedup, a terminal-run redelivery
  guard (a settled run is acked without re-running), and idempotent evidence/version writes keyed on
  `run_id`/`(playbook_id, version)`. Poison messages → DLQ.
- **Tests:** `sqs.test.ts` (redelivery doesn't re-execute; poison → DLQ).

## Reviewer sign-off

- [ ] SSRF controls + residual risks acknowledged (DNS-rebinding, webhook egress).
- [ ] Data no-leak scan reviewed; `STORE_RUN_INPUTS` + evidence retention acknowledged.
- [ ] No-code-execution control confirmed.
- [ ] Trusted-gateway auth posture accepted for this deployment (DECISIONS #32).
- [ ] Independent reviewer: ______________________  date: __________
