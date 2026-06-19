# Caller Integration Guide

How to call Rote from another service. Everything here is the **public contract** — the request
payload, the `{ meta, result }` envelope, the status vocabulary, and the error codes. (Authoritative
source: [PROJECT_SPEC.md](../PROJECT_SPEC.md) §5–§10.)

## 1. Submit a run — `POST /v1/runs`

Runs are **asynchronous**: this returns `202` with a `run_id`; you then poll or receive a webhook.

```jsonc
{
  // EITHER replay an existing playbook…
  "playbook_id": "pb_01J...",        // replay this playbook
  "playbook_version": 3,             // optional: pin a version (default = active)

  // …OR learn a new task (agent mode):
  "instruction": "Look up a license by number and last name, then read the result.",
  "url": "https://example.gov/lookup",
  "output_format": {                 // omit → action-only playbook (result: null)
    "license_status": "string",
    "holder_name": "string",
    "expiry_date": "string (ISO date)"
  },

  // common to both:
  "data": { "license_number": "A123456", "last_name": "Nguyen" },  // string|number|boolean values
  "config": { "model": "anthropic/claude-sonnet-4-6" },            // see §5; required for agent/heal/fallback
  "callback_url": "https://you.example/hooks/rote",                // optional webhook
  "idempotency_key": "your-unique-key"                             // optional dedup (see §4)
}
```

Resolution precondition: provide **`playbook_id`**, or **both `instruction` and `url`**.

**Response:** `202 { "meta": { "run_id": "run_...", "status": "queued" } }`. Rejections (validation,
backpressure, draining) return a non-2xx `{ "error": { "message", "code"?, "retry_after_seconds"? } }`
— see §6/§7.

## 2. Get a run — `GET /v1/runs/:id`

Poll until `meta.status` is terminal. The envelope:

```jsonc
{
  "meta": {
    "run_id": "run_...",
    "status": "completed",                 // see §6
    "mode": "playbook",                    // "playbook" | "agent" (agent = a learn or a self-heal)
    "playbook_id": "pb_...", "playbook_version": 3, "playbook_type": "extraction",
    "self_healed": false,                  // true → this run healed; playbook_version is the NEW version
    "llm_fallback_used": false,            // true → the surfaced LLM extraction fallback engaged
    "fallback_fields": null,               // which fields the fallback resolved
    "duration_ms": 1430, "started_at": "...", "finished_at": "...",
    "evidence": { "screenshot_url": "/v1/runs/run_.../evidence/screenshot.png", "html_url": "..." },
    "effective_config": { /* the resolved behavior config for this run */ },
    "error": null,                         // populated on failed runs — see §7
    "extraction_errors": null,             // [{ field, reason }] on partial extraction
    "webhook_status": null                 // "delivered" | "failed" | null
  },
  "result": { "license_status": "active", "holder_name": "NGUYEN, THANH A", "expiry_date": "2027-12-31" }
}
```

**`result` is only ever your `output_format` shape, or `null`** (action playbooks, or failures). All
system info lives in `meta`. New `meta` fields are additive — ignore ones you don't know.

**Evidence:** `GET` the `screenshot_url` / `html_url` (stable engine paths). With S3 storage the engine
`302`-redirects to a short-lived presigned URL — follow redirects.

## 3. Statuses & errors

`meta.status`: `queued` · `running` · `completed` · `completed_with_extraction_errors`
(some fields missing → `null` in `result`, details in `meta.extraction_errors`) · `failed`
(`result: null`, `meta.error` populated).

`meta.error.code` (the §7 set): `validation_error` · `step_failed` · `navigation_failed` · `timeout` ·
`captcha_detected` · `extraction_failed` · `agent_gave_up` · `browser_crashed` · `playbook_not_found` ·
`internal_error`. A field that can't be extracted is reported missing — **never guessed**.

Transport-level rejections (not a run failure) come back on the `POST`: `422` validation,
`404` playbook not found, `429` `{ error: { retry_after_seconds } }` + `Retry-After` (queue full),
`503` (draining for shutdown). Retry `429`/`503` with backoff.

## 4. Idempotency

Supply `idempotency_key` and a retried `POST` returns the **original** `run_id` — never a second
browser run. Use it to make submission safe under your own retries. (Scope is global in v1.)

## 5. The `model` field (agent / heal / fallback only)

`config.model` is `"provider/name"` (e.g. `anthropic/claude-sonnet-4-6`, `openai/gpt-...`,
`ollama/...`). **There is no default** — a run that needs a model with none set fails
`validation_error`. Replays are model-free; the requirement only bites for a learn, a self-heal, or the
LLM fallback. Operators can set `CONFIG_MODEL` in env to cover those. Provider **keys are env-only** —
a payload picks the provider/model but never supplies a secret.

## 6. Webhooks

If you set `callback_url`, the engine `POST`s the terminal `{ meta, result }` envelope to it (retried
with backoff on non-2xx; outcome in `meta.webhook_status`). **v1 webhooks are unsigned** — the engine
runs behind a trusted gateway, so verify via your private network / the gateway. (HMAC
`X-Engine-Signature` is a future addition alongside caller auth.)

## 7. Minimal client loop (pseudocode)

```
run_id = POST /v1/runs { playbook_id, data, idempotency_key }      # 202
loop:
  e = GET /v1/runs/run_id
  if e.meta.status in {completed, completed_with_extraction_errors, failed}: break
  sleep(backoff)
use e.result (and e.meta.error / e.meta.extraction_errors if not fully completed)
```
