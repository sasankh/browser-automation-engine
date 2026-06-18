# API Reference

> The caller-facing contract. This is the surface every consumer integrates against — once a caller is live, changes here are breaking changes (see `EXECUTION_STANDARDS.md` §2: contract drift is a STOP-and-ask).
>
> Authoritative for: endpoints, payload, the `{meta, result}` envelope, statuses, error codes, webhook verification. Derived from `PROJECT_SPEC.md` §4–§7; if this and the spec disagree, reconcile them — they must not diverge.

## 1. Transports

Two transports, **one payload schema, one response envelope**. An HTTP `POST /v1/runs` body and an SQS message body are identical.

```
POST   /v1/runs                        submit a run         → 202 { meta: { run_id, status: "queued" } }
GET    /v1/runs/{run_id}               poll status/result   → envelope
GET    /v1/runs/{run_id}/evidence      evidence (signed URL or stream)
GET    /v1/playbooks                   list playbooks       (filter: ?health=unhealthy)
GET    /v1/playbooks/{id}              contract: required_data_keys, output_format, versions, active_version
GET    /v1/playbooks/{id}/versions/{v} specific version detail
POST   /v1/playbooks/{id}/activate     move active_version pointer { "version": n }   (rollback)
DELETE /v1/playbooks/{id}              soft-delete (tombstone; versions retained)
GET    /v1/health                      liveness + DB/browser/storage + saturation
GET    /metrics                        Prometheus
```

`POST /v1/runs` is **always async**: validate → persist → enqueue → `202`. Results arrive by webhook (`callback_url`) and/or polling. (Synchronous `?wait=true` is not in v1 — see `DECISIONS.md` D2.)

## 2. Request payload

```jsonc
{
  // Task definition (first run / self-heal source)
  "instruction": "string",          // required if no playbook_id
  "url": "https://target/path",     // required with instruction
  "output_format": { },             // optional; absent = action-only task (result is null)

  // Replay
  "playbook_id": "pb_...",          // optional; if present → playbook mode
  "playbook_version": 3,            // optional; pin a version (default = active_version)

  // Inputs
  "data": { },                      // flat object; self-describing keys; values used on the page

  // Per-run config overrides (subset only — see §6)
  "config": { "playbook_self_heal": true },

  // Delivery
  "callback_url": "https://caller/hook",   // optional
  "idempotency_key": "caller-unique"       // optional, strongly recommended
}
```

### Field rules

- **`data`** — flat JSON; keys caller-chosen and self-describing (`license_number`, `last_name`). Values: string/number/boolean (lists/objects are v2). On replay, validated against the playbook's `required_data_keys` **before a browser launches**; missing keys → `422`. Treated as sensitive: redacted in logs, never stored in playbook bodies.
- **`output_format`** — object of `field → type hint` (`"string"`, `"number"`, `"boolean"`, `"array of strings"`, `"string (ISO date)"`, nested objects allowed). Drives validated extraction. Saved into the playbook **per version**; replays don't resend it. Absent on first run → action-only playbook.
- **`playbook_id` + `output_format`** together → creates a new version with an updated extraction step.
- **`idempotency_key`** — a repeat with the same `(caller, key)` returns the original run's envelope; no second browser run.

### Resolution logic (which mode runs)

```
playbook_id present?  → load (pinned|active) → validate data → PLAYBOOK MODE
                        on failure + self_heal → agent heals → new version
else instruction?     → AGENT MODE → on success compile playbook, return its id
else                  → 422 validation_error
```

## 3. Response envelope

Every result — poll response, webhook body, results-queue message — is the same object. **`result` is only ever the caller's `output_format` shape, or `null`. All system info is in `meta`.**

```jsonc
{
  "meta": {
    "run_id": "run_...",
    "status": "completed",            // see §4
    "mode": "playbook",               // "playbook" | "agent"
    "playbook_id": "pb_...",
    "playbook_version": 3,
    "playbook_type": "extraction",    // "extraction" | "action"
    "self_healed": false,             // true → playbook_version is the NEW (healed) version
    "llm_fallback_used": false,       // true → structural extraction was rescued by the LLM
    "fallback_fields": null,          // fields the LLM fallback resolved, when used
    "duration_ms": 41250,
    "started_at": "2026-06-10T15:02:11Z",
    "finished_at": "2026-06-10T15:02:52Z",
    "evidence": { "screenshot_url": "...", "html_url": "..." },
    "effective_config": { },          // fully resolved config for this run
    "error": null,                    // see §4
    "extraction_errors": null         // see §4
  },
  "result": { }                       // caller's output_format shape, or null
}
```

Webhooks are delivered to `callback_url` and retried (`WEBHOOK_MAX_RETRIES`, default 3, backoff) on non-2xx; the outcome is recorded in `meta.webhook_status`. **They are unsigned in v1** — the engine runs behind a trusted gateway (see §7). New `meta` fields may be added over time (additive, non-breaking); never assume `meta` is closed.

## 4. Statuses & errors

| `meta.status` | Terminal | Meaning |
|---|---|---|
| `queued` | no | Accepted, awaiting a worker. |
| `running` | no | Browser session in progress. |
| `completed` | yes | Done; for an extraction playbook, `result` fully satisfies the format. |
| `completed_with_extraction_errors` | yes | Done; some fields missing → `null` in `result`, details in `meta.extraction_errors`. |
| `failed` | yes | Did not complete. `result: null`, `meta.error` populated. |

Webhooks fire only on **terminal** states.

`meta.error`:

```json
{ "code": "step_failed", "step": 4, "message": "selector #x not found",
  "heal_attempted": true, "heal_outcome": "agent_could_not_locate_form" }
```

`meta.extraction_errors`:

```json
[ { "field": "expiry_date", "reason": "not_found_on_page" } ]
```

**Error codes** (initial set): `validation_error`, `step_failed`, `navigation_failed`, `timeout`, `captcha_detected`, `extraction_failed`, `agent_gave_up`, `browser_crashed`, `playbook_not_found`, `internal_error`.

**Heal policy per code** (see `PROJECT_SPEC.md` §7 for the full table): heals — `step_failed`, `navigation_failed`, and `extraction_failed` (only if `self_heal_on_extraction_failure`); infra-retry — `browser_crashed`; never heals — `captcha_detected`, `timeout`, `validation_error`, `playbook_not_found`, `agent_gave_up`, `internal_error`. Heal also always requires `playbook_self_heal=true`.

## 5. Worked examples

**First run (learn) — extraction**

```jsonc
// POST /v1/runs
{ "instruction": "Look up the license and get its details",
  "url": "https://example-board/lookup",
  "data": { "license_number": "A123456", "last_name": "Nguyen" },
  "output_format": { "license_status": "string", "holder_name": "string", "expiry_date": "string (ISO date)" },
  "callback_url": "https://caller/hook", "idempotency_key": "case-88421" }
// → 202 { "meta": { "run_id": "run_...", "status": "queued" } }
// webhook → meta.mode="agent", meta.playbook_id="pb_...", meta.playbook_version=1,
//           result={ license_status:"active", holder_name:"NGUYEN, THANH A", expiry_date:"2026-12-31" }
```

**Replay (cheap path)**

```jsonc
{ "playbook_id": "pb_...", "data": { "license_number": "B998877", "last_name": "Okafor" } }
// webhook → meta.mode="playbook", result={ ... }   (no LLM)
```

**Action-only (no output_format)**

```jsonc
{ "instruction": "Fill in the contact form and submit it", "url": "https://example/contact",
  "data": { "name": "...", "email": "...", "message": "..." } }
// webhook → meta.playbook_type="action", result=null
```

## 6. Config overrides (payload `config`)

Resolution per key: **payload `config` > env > built-in default** (`PROJECT_SPEC.md` §10). Overridable (behavior) keys include: `playbook_self_heal`, `self_heal_on_extraction_failure`, `run_timeout_seconds` (capped by `MAX_RUN_TIMEOUT_SECONDS`), `agent_max_steps`, `model` (`provider/name`, **required** — no built-in default), `evidence_capture`, `evidence_inline`, `proxy_enabled`, `headless`, `allow_offsite`, `replay_llm_fallback` (+ model), `force_relearn`.

**Not overridable** (env-only — destinations, secrets, capacity): storage backends/buckets, SQS, `DATABASE_URL`, model-provider keys/endpoints (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OLLAMA_BASE_URL`), auth/webhook secrets (reserved — §7), proxy creds, `SERVICE_MODE`, `MAX_CONCURRENT_RUNS`, `MAX_QUEUE_DEPTH`, `BROWSER_RECYCLE_RUNS`, `MAX_RUN_TIMEOUT_SECONDS`. A payload can never change where data is stored/sent or raise resource ceilings.

## 7. Webhook delivery & trust

Webhooks are **unsigned in v1**. The engine is designed to run **behind a trusted gateway** on a private network, so caller authentication and webhook verification are the gateway's responsibility, not the engine's (`API_AUTH_MODE=none`; DECISIONS #32). Treat a webhook as authentic because it arrived over your trusted path — verify the source via your network/gateway, not a signature.

Delivery semantics: the terminal envelope is POSTed to `callback_url` and retried (`WEBHOOK_MAX_RETRIES`, default 3, with backoff) on any non-2xx; the final outcome is recorded in `meta.webhook_status` (`delivered` | `failed`). Webhooks fire only on terminal states.

An `X-Engine-Signature` HMAC (per-caller secret over the raw body) is **reserved** for whenever in-engine caller auth is added (DECISIONS #30/#32); it is not emitted today.
