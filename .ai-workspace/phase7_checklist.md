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
- [ ] `SsrfGuard`: deny RFC1918 / 169.254.0.0/16 / loopback / link-local for `url` and every agent navigation; `ALLOWED_PRIVATE_CIDRS` opt-in.
- [ ] `Redactor`: `data` values redacted in logs/traces; run rows store keys not values (unless `STORE_RUN_INPUTS=true`).
- [ ] Confirm playbook bodies never contain raw `data` values (only `{{data.*}}`) — automated check in the compiler tests.
- [ ] ~~Auth mode enforcement (`none|api_key|hmac`)~~ — **DESCOPED to the upstream gateway (DECISIONS #32)**; engine runs `none`. Add a `SECURITY_REVIEW.md` documenting the trusted-gateway posture (#33).
- [ ] Confirm no playbook content is ever `eval`'d (op-vocabulary interpreter only).

**Observability (architecture §11)**
- [ ] Prometheus `/metrics`: `runs_total{mode,status}`, `heal_total{outcome}`, `fallback_engaged_total`, `agent_tokens_total`, `run_duration_seconds{mode}`, `playbook_hit_ratio`, saturation gauges, `requests_rejected_total{reason}`, `webhook_delivery_total`.
- [ ] Per-playbook health rollup endpoint/filter (`?health=unhealthy`).

**Chaos & resilience**
- [ ] Kill browser mid-run → clean failure + slot reclaimed.
- [ ] Storage unavailable (Postgres/S3) → graceful degradation + clear errors.
- [ ] SQS visibility expiry mid-run → safe redelivery.
- [ ] Queue-full backpressure under sustained burst.

**Docs**
- [ ] README quickstart (`docker run` local mode).
- [ ] Caller integration guide: payload reference, envelope reference, webhook verification, status/error codes.
- [ ] Operator guide: env reference, concurrency tuning, scaling on ECS, evidence retention.
- [ ] `DECISIONS.md` finalized; open questions (§17) updated with any v1 resolutions.

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
- [ ] Commit as `Phase 7: <summary>`.
- [ ] **STOP.** Do not start or plan the next phase until the user says so (EXECUTION_STANDARDS §7).

## Notes (fill during execution)

> Empty Notes after a phase is a red flag, not a clean bill (EXECUTION_STANDARDS §1.5).

**Kickoff (2026-06-17) — pre-build:**
- **Pinned versions (to install at build):** `prom-client` (latest-stable; `npm view` at install). No other dep changes.
- **Scope decision (DECISIONS #32):** in-engine **auth / API keys / webhook signing are DESCOPED** — terminated by the upstream gateway; engine runs the `none` posture. Resolves the Phase-6 webhook-signing carry-forward (#30). In-scope = the engine's own responsibilities: SSRF (outbound egress), data no-leak/redaction, no-`eval`, `/metrics`, chaos, docs.
- **Security gate (DECISIONS #33):** I write `SECURITY_REVIEW.md` (adversarial self-review) + dogfood-quality docs; the **independent sign-off / docs-dogfood is the user's** to close (recorded honestly, not self-attested as independent). User may also run `/security-review` as a second automated pass.
- **As-built reconciliation:** logger redacts `data`; run rows store keys (secure default); provenance ⇒ no raw values in playbook bodies; no `eval`. Build: `redactor.ts` (+ the automated no-leak scan over logs/run-rows/playbook-bodies), `metrics.ts` (+ `/metrics`, the §11 metric set), SSRF hardening (apply to the replay `goto`; `ALLOWED_PRIVATE_CIDRS` replacing the boolean), `STORE_RUN_INPUTS` flag (default off), chaos tests (storage-down, browser-kill, redelivery, queue-full — some already covered by Phase 3/6 tests).
- **Contract:** unchanged. A `/metrics` endpoint is additive; no new §7 error codes (no auth path).
- **Open items carried forward:** independent security sign-off + docs dogfood (user); per-caller webhook signing/auth (gateway / v2).
