# Security Model

> Consolidates the security posture from `PROJECT_SPEC.md` §13 and `ARCHITECTURE.md` §9. For a compliance-adjacent system, these are invariants, not aspirations. Most are enforced and tested in Phase 7, but several (isolation, redaction, no-eval) are built in from their originating phase.

## 1. Threat surfaces & controls

| Surface | Risk | Control |
|---|---|---|
| `url` + agent navigation | SSRF to internal/metadata endpoints | Deny RFC1918, 169.254.0.0/16, loopback, link-local — at URL validation **and** container network. Applies to agent nav too, not just the initial URL. `ALLOWED_PRIVATE_CIDRS` opt-in. |
| `data` values | Leak of PII into logs/playbooks/DB | Redacted in logs/traces; **never** persisted into playbook bodies (only `{{data.*}}` refs); run rows store keys not values unless `STORE_RUN_INPUTS=true`. |
| Playbook bodies | Code execution via learned artifact | Playbooks are data: a fixed op vocabulary is interpreted; nothing from a body is ever `eval`'d / `Function()`'d. Bodies are JSON-Schema-validated on load. |
| Concurrent runs | Cross-request data bleed | One `BrowserContext` per run; no shared mutable run state; keyed evidence/version paths (`ARCHITECTURE.md` §8.1). Tested by the Phase 3 isolation test. |
| Webhooks | Forged/tampered result delivery | HMAC-SHA256 over the raw body (`X-Engine-Signature`); callers verify constant-time. |
| API access | Unauthorized runs | `API_AUTH_MODE` = `none` (internal trust) \| `api_key` \| `hmac`; the `caller` scope drives idempotency + (future) tenancy. |
| Secrets | Exposure | `ANTHROPIC_API_KEY`, proxy creds, webhook + auth secrets, `DATABASE_URL` are env/secret-manager only — never in payloads, never overridable by `config`. |
| Payload config | Privilege/resource escalation | `config` can change behavior but never destinations or capacity ceilings (`MAX_CONCURRENT_RUNS` etc. are env-only). |

## 2. Data handling

- `data` is sensitive by default. The provenance-templating mechanism (`ARCHITECTURE.md` §4) guarantees only `{{data.key}}` references land in playbook bodies — verified by an automated compiler test.
- The **no-leak scan** (Phase 7, in CI): assert no raw `data` value appears in any log line, trace, run row, or playbook body.
- Evidence (screenshots/HTML) may contain rendered PII from the target page. It's keyed by `run_id`, access-controlled by the storage backend, and retained per the deployer's policy — treat the evidence store as a sensitive data store.

## 3. CAPTCHA & anti-bot

The engine does **not** solve CAPTCHAs or evade bot detection (`PROJECT_SPEC.md` non-goals). A detected CAPTCHA is a clean `captcha_detected` failure that never self-heals (re-running won't pass it). This is a deliberate ethical/legal boundary, not a missing feature.

## 4. Tenancy (v1 posture)

v1 is single-trust-domain. `caller` scoping on API keys and idempotency is the seam along which per-tenant isolation (namespaced playbooks, quotas) would later be added — but no cross-tenant guarantees are claimed in v1. Don't deploy v1 as a shared multi-tenant service without adding that layer.

## 5. Review gate (Phase 7)

Walk the table in §1 as an attacker:
- SSRF — private-IP `url` and an agent attempting off-site/internal navigation are both blocked.
- Exfiltration — the no-leak scan is green.
- Code execution — confirm nothing from a playbook is evaluated.
- Auth — the chosen mode is enforced on every mutating route.

Given the compliance-adjacency, the gate requires an **independent review sign-off** (a second set of eyes), not self-attestation.
