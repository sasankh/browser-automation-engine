# Phase 7 — Hardening, Security, Observability, Docs — Plan

> Status: **DRAFT**. Companion: [phase7_checklist.md](./phase7_checklist.md). Master refs: `PROJECT_SPEC.md` §13, §14 · `ARCHITECTURE.md` §9, §11.

## Goal

Close the security and operability gaps before real traffic. This is a named phase with its own gate — not a backlog. For a compliance-adjacent system, "production-ready" must be an explicit, reviewed standard, not an assumption.

## Design decisions

- **SSRF applies to agent navigation too**, not just the initial `url` (ARCHITECTURE §9). Deny RFC1918 / 169.254.0.0/16 / loopback / link-local at both URL validation and the container network layer; `ALLOWED_PRIVATE_CIDRS` opt-in for deliberate internal targets.
- **No-leak is testable, so test it.** An automated scan asserts no raw `data` value appears in any log, trace, run row, or playbook body. The provenance templating from Phase 4 already guarantees playbook bodies hold only `{{data.*}}`; this phase proves it and covers the other surfaces.
- **Playbooks are data, never code** — re-assert with a test that nothing from a playbook body is ever `eval`'d.
- **Auth enforcement** per the Phase-0 decision (`none|api_key|hmac`); secrets via env/secret-manager only.

## File-by-file (indicative)

- `src/browser/ssrf-guard.ts` — deny rules for `url` + agent navigation.
- `src/shared/redactor.ts` — redact `data` values in logs/traces; run rows store keys not values (unless `STORE_RUN_INPUTS`).
- `src/shared/metrics.ts` — Prometheus `/metrics`: `runs_total{mode,status}`, `heal_total{outcome}`, `fallback_engaged_total`, `agent_tokens_total`, `run_duration_seconds{mode}`, `playbook_hit_ratio`, saturation gauges, `requests_rejected_total{reason}`, `webhook_delivery_total`.
- `src/intake/auth.ts` — finalize the chosen auth mode.
- Docs: README quickstart, caller integration guide (payload/envelope/webhook-verification/status+error codes), operator guide (env reference, concurrency tuning, ECS scaling, evidence retention), finalized `DECISIONS.md`.

## Chaos scenarios (must all degrade cleanly)

- Kill browser mid-run → clean failure + slot reclaimed.
- Storage unavailable (Postgres/S3) → graceful degradation + clear errors, no red-screen 500s.
- SQS visibility expiry mid-run → safe redelivery (no duplicate effects).
- Queue-full backpressure under sustained burst → `429`s, stable engine.

## Edge cases / risks

- **Security review needs a second set of eyes** — given the compliance-adjacency, the gate's manual verify calls for an independent review sign-off, not self-attestation.
- **Docs dogfood** — someone uninvolved must be able to integrate a run + webhook from the docs alone; if they can't, the docs aren't done.
- **Metric completeness** — a dashboard must be able to chart heal rate, fallback rate, saturation, and token spend from `/metrics` as shipped.

## Exit

Safe to point real callers and real traffic at it: SSRF blocked (incl. agent off-site nav); no-leak scan green in CI; all four chaos scenarios clean and recoverable; `/metrics` complete; security review signed off; docs dogfooded by someone uninvolved.
