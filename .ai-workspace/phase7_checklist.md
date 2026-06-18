# Phase 7 — Hardening, Security, Observability, Docs — Checklist

> Status: **DRAFT** (authored upfront). Execute only after §0 below and an explicit user go-ahead.
> Tasks: this file. *How* to execute: [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md). Deep-dive: [phase7_plan.md](./phase7_plan.md).

## §0 Phase Kickoff Revisit (mandatory — do before any code)

Reality drifts; this gate exists because earlier phases may have changed assumptions.

- [x] Re-read [EXECUTION_STANDARDS.md](../EXECUTION_STANDARDS.md) in full (re-read across the Phase 4–6 kickoffs this session; still in force).
- [x] Re-read [phase7_plan.md](./phase7_plan.md) and this checklist end to end.
- [x] Re-read the referenced master sections: PROJECT_SPEC.md §13, §14 · ARCHITECTURE.md §9, §11.
- [x] Confirm the **Phase 6 Plan & Verify gate actually passed** — verified this session: offline 83/3-skip, cloud api→SQS→worker→S3 e2e PASS.
- [x] Reconcile the plan against the codebase **as actually built** — logger already redacts `data`; run rows store keys-not-values (secure default); `{{data.*}}` provenance ⇒ no raw values in playbook bodies; op-interpreter never `eval`s. **Gaps:** no `auth.ts`/`redactor.ts`/`metrics.ts`; SSRF wired only on the AGENT path (not replay `goto`) + uses boolean `ALLOW_PRIVATE_TARGETS` (plan wants `ALLOWED_PRIVATE_CIDRS`); idempotency caller hardcoded `"default"`.
- [x] Verify library/API choices are still current — to add: **`prom-client`** (latest-stable) for `/metrics`. Stagehand/Playwright/Fastify/pg/Zod/aws-sdk unchanged from Phase 6.
- [x] Surface every open question / ambiguity / trade-off to the user — 3 surfaced + answered: **auth/api-key/webhook-signing DESCOPED to the upstream gateway** (DECISIONS #32); self-review + user sign-off (#33). No contract break (auth/metrics rejections follow the 429 transport-rejection pattern, no new §7 code).
- [x] Update the plan + checklist for anything learned, then get the user's **explicit go-ahead**. — plan + checklist + DECISIONS #32–#33 updated; **awaiting explicit "start Phase 7" before any code.**

---


Named phase, own gate — not a backlog. Close the security and operability gaps before real traffic.

### Tasks

**Security (architecture §9)**
- [x] `SsrfGuard`: deny RFC1918 / `169.254/16` / loopback / link-local / CGNAT / metadata for the **initial url, every agent navigation, AND the replay `goto`** (`RunOrchestrator.replayTargetBlocked`); `ALLOWED_PRIVATE_CIDRS` allowlist. — `ssrf-guard.test.ts` + `security.test.ts`.
- [x] `Redactor` (`src/shared/redactor.ts`): `data` values masked in free-text logs (pino redacts the structured `data` object; the redactor covers Stagehand log lines); run rows store **keys not values** unless `STORE_RUN_INPUTS=true` (migration 0004 `data_values`). — no-leak scan + `redactor.test.ts`.
- [x] Confirm playbook bodies never contain raw `data` values (only `{{data.*}}`) — provenance templating (compiler/provenance tests) + the no-leak scan asserts it directly.
- [ ] ~~Auth mode enforcement (`none|api_key|hmac`)~~ — **DESCOPED to the upstream gateway (DECISIONS #32)**; engine runs `none`. Add a `SECURITY_REVIEW.md` documenting the trusted-gateway posture (#33).
- [x] Confirm no playbook content is ever `eval`'d (op-vocabulary interpreter only). — `security.test.ts`: schema rejects off-vocabulary ops; interpreter sources contain no `eval(`/`new Function(`.

**Observability (architecture §11)**
- [x] Prometheus `/metrics` with the full set (`runs_total{mode,status}`, `heal_total{outcome}`, `fallback_engaged_total{playbook_id}`, `agent_tokens_total{kind}`, `run_duration_seconds{mode}`, `playbook_hit_ratio`, saturation gauges, `requests_rejected_total{reason}`, `webhook_delivery_total{status}` + default process metrics). — `metrics.test.ts` + verified cold on the dockerized api.
- [x] Per-playbook health rollup (`GET /v1/playbooks?health=unhealthy`) — already shipped (Phase 5).

**Chaos & resilience**
- [x] Kill browser / wedged run mid-run → clean `timeout` failure + slot reclaimed — Phase 3 `concurrency.test.ts` (timeout + drain).
- [x] Storage unavailable (Postgres/S3) → graceful degradation — `chaos.test.ts`: evidence-store down → run still completes (best-effort); Postgres down → `/v1/health` 503 `degraded` (no stack leaked).
- [x] SQS visibility expiry / redelivery mid-run → safe redelivery (no duplicate effects) — Phase 6 `sqs.test.ts` (redelivery-idempotency).
- [x] Queue-full backpressure under sustained burst → `429` + `Retry-After`, stable engine — Phase 3 `concurrency.test.ts` (backpressure).

**Docs**
- [x] `README.md` quickstart (`docker compose up`, replay + learn curls, the two-speed thesis).
- [x] `docs/CALLER_GUIDE.md`: payload + envelope reference, status/error codes, webhook (unsigned — gateway posture), idempotency, polling loop.
- [x] `docs/OPERATOR_GUIDE.md`: env reference, topologies, concurrency tuning, ECS scaling, evidence retention, `/metrics`.
- [x] `DECISIONS.md` finalized (#32–#33). `SECURITY_REVIEW.md` written for independent sign-off (#33).

### Acceptance criteria
- SSRF attempts (private IP `url`, agent off-site nav) are blocked with the right error.
- No raw `data` value appears in any log, trace, run row, or playbook body (automated scan).
- `/metrics` exposes the full set; a dashboard can chart heal rate, fallback rate, saturation, token spend.
- All four chaos scenarios produce clean, observable, recoverable behavior.
- A new caller can integrate from the docs alone (dogfood: have someone unfamiliar wire up a run + webhook from the guide).

### ▣ Plan & Verify gate — Phase 7
- **Plan check:** Walk the security list as an attacker — SSRF, data exfiltration via logs, code execution via playbook, missing auth. Every item closed and tested?
- **Verify (automated):** SSRF tests; redaction/no-leak scan in CI; chaos suite green; metrics-presence test.
- **Verify (manual):** security review sign-off (ideally a second set of eyes, given this is a compliance-adjacent system); docs dogfood by someone uninvolved.
- **Exit condition:** safe to point real callers and real traffic at it. Production-ready by an explicit, reviewed standard — not by assumption.

## ▣ Phase Review & Verification (mandatory — do before declaring the phase done)

Run this section literally, in order. A phase is **not done** until every box here is checked. Per EXECUTION_STANDARDS §1.6 and §5, green unit tests do not prove the behavior is right — re-verify by observation.

### Re-verification (cold)
- [x] Re-read this checklist top to bottom; every box reflects observation.
- [x] Re-read the plan + `PROJECT_SPEC.md §13/§14` / `ARCHITECTURE.md §9/§11`; built matches spec. As-built (synced/noted): replay-`goto` SSRF, `ALLOWED_PRIVATE_CIDRS`, `STORE_RUN_INPUTS` + `data_values` (migration 0004), `/metrics`, auth descoped (#32). `.env.example` updated.
- [x] `npx tsc --noEmit` clean; `eslint .` clean.
- [x] Full suite green — **97 passed, 3 live-skipped** (22 files). Phase 3 isolation + Phase 4 round-trip green inside it.
- [x] **Cold start (dockerized):** rebuilt the cloud topology with Phase 7 code; `/metrics` present cold on the api (full set + process metrics); `scripts/docker-cloud-check.ts` → **api→SQS→worker→S3 e2e PASS** (a cold worker's first browser launch is slow — bumped the script timeout to 150s; the run completes).

### Bug sweep
- [x] Walked the security list as an attacker: SSRF (private-IP url / replay goto / metadata → blocked), data-exfil (sentinel never in logs/run-row/playbook-body), code-exec (off-vocab op rejected, no `eval` in interpreter), DoS (Phase 3 cap/backpressure/timeout), redelivery dup (Phase 6). **Found + fixed:** the replay path wasn't SSRF-guarded (now `replayTargetBlocked`); the integration harnesses needed `ALLOW_PRIVATE_TARGETS=true` for the fixture once the replay guard landed.
- [x] Defects fixed; full suite re-run green.
- [x] No regression — Phase 3/4/5/6 all green after the SSRF/metrics/redaction changes.
- [x] Contract intact: payload → `{meta,result}`, statuses + §7 codes unchanged. `webhook_status` (Phase 6) is the only additive `meta` field; `/metrics` is a new additive endpoint; SSRF blocks surface as the existing `navigation_failed`. No new error codes (auth descoped).

### Standing regression gates (must stay green once their phase has landed)
- [x] Phase 3 isolation cross-contamination test — green (in the full suite).
- [x] Phase 4 learn→replay round-trip — green offline + LIVE.

### Sign-off
- [x] Notes filled (versions, deviations, warnings, carried-forward).
- [x] `DECISIONS.md` updated (#32–#33 at kickoff; no new this gate).
- [x] `PROJECT_CHECKLIST.md` status reflects reality (Phase 7 complete — **final phase**; v1 done).
- [x] Commit as `Phase 7: <summary>`. — `Phase 7: hardening, security, observability, docs (v1 complete)`.
- [x] **STOP.** Independent security sign-off + docs dogfood remain the user's to close (DECISIONS #33). v1 (Phases 0–7) complete.

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

**Kickoff (2026-06-17) — pre-build:**
- **Pinned versions (to install at build):** `prom-client` (latest-stable; `npm view` at install). No other dep changes.
- **Scope decision (DECISIONS #32):** in-engine **auth / API keys / webhook signing are DESCOPED** — terminated by the upstream gateway; engine runs the `none` posture. Resolves the Phase-6 webhook-signing carry-forward (#30). In-scope = the engine's own responsibilities: SSRF (outbound egress), data no-leak/redaction, no-`eval`, `/metrics`, chaos, docs.
- **Security gate (DECISIONS #33):** I write `SECURITY_REVIEW.md` (adversarial self-review) + dogfood-quality docs; the **independent sign-off / docs-dogfood is the user's** to close (recorded honestly, not self-attested as independent). User may also run `/security-review` as a second automated pass.
- **As-built reconciliation:** logger redacts `data`; run rows store keys (secure default); provenance ⇒ no raw values in playbook bodies; no `eval`. Build: `redactor.ts` (+ the automated no-leak scan over logs/run-rows/playbook-bodies), `metrics.ts` (+ `/metrics`, the §11 metric set), SSRF hardening (apply to the replay `goto`; `ALLOWED_PRIVATE_CIDRS` replacing the boolean), `STORE_RUN_INPUTS` flag (default off), chaos tests (storage-down, browser-kill, redelivery, queue-full — some already covered by Phase 3/6 tests).
- **Contract:** unchanged. A `/metrics` endpoint is additive; no new §7 error codes (no auth path).
- **Open items carried forward:** independent security sign-off + docs dogfood (user); per-caller webhook signing/auth (gateway / v2).

**Build (2026-06-17) — as-built:**
- **Pinned versions:** `prom-client@15.1.3`. No other dep changes.
- **New modules:** `src/shared/redactor.ts`, `src/shared/metrics.ts` (+ `/metrics` route, saturation gauges registered at boot), migration `0004_run_inputs.sql` (`runs.data_values`). SSRF guard rewritten with CIDR allowlisting (`buildUrlGuardOptions`, `parseCidr`, `ipInCidr`) + wired to the replay path. Docs: `README.md`, `docs/CALLER_GUIDE.md`, `docs/OPERATOR_GUIDE.md`, `SECURITY_REVIEW.md`.
- **Deviations from plan:** (1) auth/api-key/webhook-signing **descoped** to the gateway (#32); (2) `evidence_inline` base64 remains deferred (Phase 6 carry); (3) `webhook_status` is an additive `meta` field (Phase 6); (4) `playbook_hit_ratio` is a running gauge (replay/total) rather than a recording rule.
- **Residual security risks (in SECURITY_REVIEW.md):** SSRF uses literal-host checks — a public DNS name resolving to a private IP (rebinding) isn't blocked at resolution (mitigate with VPC egress rules); no SSRF check on outbound webhook `callback_url` (trusted-gateway posture). Both documented for the reviewer.
- **Bug fixed:** the replay path had no SSRF guard (Phase 4 only guarded the agent path) — added `replayTargetBlocked`; this required `ALLOW_PRIVATE_TARGETS=true` in the integration harnesses (they target the 127.0.0.1 fixture).
- **Verification:** offline `ssrf-guard.test.ts` (9), `redactor.test.ts` (4), `security.test.ts` (5: replay-SSRF-block ×2, no-leak scan, no-eval ×2), `metrics.test.ts` (1), `chaos.test.ts` (2). Full suite 97 passed / 3 live-skipped. Dockerized cold-start: `/metrics` + cloud api→SQS→worker→S3 e2e green.
- **v1 status:** all of Phases 0–7 landed. The one remaining gate is the user's INDEPENDENT security sign-off + docs dogfood (#33).
