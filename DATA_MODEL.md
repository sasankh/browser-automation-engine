# Data Model

> Authoritative for every persisted structure: the Postgres schema (run records + playbook index), the on-disk/S3 playbook body format, and the evidence layout. The playbook op vocabulary defined here is the most safety-critical structure in the system — it is the fixed, interpreted vocabulary chosen deliberately over generated code (`ARCHITECTURE.md` §4.4). Extend it by adding ops to the interpreter, never by embedding code in a playbook.
>
> Derived from `ARCHITECTURE.md` §5.1 and `PROJECT_SPEC.md` §8.

## 1. Storage split

| Concern | Backend | Why |
|---|---|---|
| Run records + playbook index + idempotency | **PostgreSQL (always)** | Queryable lifecycle, transactional `active_version` pointer, dedupe, health rollups |
| Playbook version bodies (`vN.json`) | local FS \| S3 | Portable, diffable, versioned blobs; co-located layout |
| Evidence (screenshot/HTML/trace) | local FS \| S3 | Large blobs, deployer-managed lifecycle |
| Selector cache (Stagehand `observe()`) | local FS \| S3 | Optional speedup; regenerable |

Postgres holds **pointers** to bodies (`body_uri`), not the bodies themselves — rows stay small and a playbook library stays portable as files.

## 2. PostgreSQL schema

```sql
CREATE TABLE playbooks (
  id                         TEXT PRIMARY KEY,            -- pb_...
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  url                        TEXT NOT NULL,
  instruction                TEXT NOT NULL,               -- used for self-heal
  playbook_type              TEXT NOT NULL,               -- 'extraction' | 'action'
  required_data_keys         TEXT[] NOT NULL DEFAULT '{}',
  active_version             INT  NOT NULL,
  health                     TEXT NOT NULL DEFAULT 'healthy', -- 'healthy' | 'unhealthy'
  consecutive_heal_failures  INT  NOT NULL DEFAULT 0,
  deleted                    BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE playbook_versions (
  playbook_id    TEXT NOT NULL REFERENCES playbooks(id),
  version        INT  NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     TEXT NOT NULL,            -- 'agent_initial' | 'self_heal' | 'manual' | 'format_change'
  created_by_run TEXT,                     -- run_id that produced this version
  output_format  JSONB,                    -- saved format (null for action type)
  body_uri       TEXT NOT NULL,            -- pointer into the playbook store
  PRIMARY KEY (playbook_id, version)
);

CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,      -- run_...
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT NOT NULL,         -- queued|running|completed|completed_with_extraction_errors|failed
  mode               TEXT,                  -- playbook | agent
  playbook_id        TEXT,
  playbook_version   INT,
  self_healed        BOOLEAN NOT NULL DEFAULT false,
  llm_fallback_used  BOOLEAN NOT NULL DEFAULT false,
  effective_config   JSONB NOT NULL,
  error              JSONB,
  extraction_errors  JSONB,
  data_keys          TEXT[] NOT NULL DEFAULT '{}',  -- keys only; values never stored unless STORE_RUN_INPUTS
  evidence_uri       TEXT,
  callback_url       TEXT,
  webhook_status     TEXT,                  -- pending | delivered | failed
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ
);

CREATE TABLE idempotency_keys (
  caller          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caller, idempotency_key)
);
```

**Transactional invariant:** the `active_version` move (on heal/relearn/activate) is a single transaction — insert the `playbook_versions` row, then update `playbooks.active_version` — so a reader never sees a dangling pointer. Migrations are append-only and numbered; never edit a shipped migration.

## 3. Playbook body layout (store)

Identical on local FS and S3 (prefix = key prefix):

```
playbooks/
  pb_01J9XK/
    meta.json
    v1.json
    v2.json
    v3.json
```

### `meta.json`

```jsonc
{
  "playbook_id": "pb_01J9XK...",
  "created_at": "2026-06-01T...",
  "active_version": 3,
  "playbook_type": "extraction",
  "instruction": "original instruction (self-heal source)",
  "url": "https://...",
  "required_data_keys": ["license_number", "last_name"],
  "deleted": false,
  "versions": [
    { "version": 1, "created_at": "...", "created_by": "agent_initial", "run_id": "run_..." },
    { "version": 2, "created_at": "...", "created_by": "self_heal",     "run_id": "run_..." },
    { "version": 3, "created_at": "...", "created_by": "self_heal",     "run_id": "run_..." }
  ]
}
```

`meta.json` mirrors the Postgres index (Postgres is authoritative for queries/transactions; `meta.json` keeps the body self-describing and portable). Keep them in sync on every write.

## 4. Version file (`vN.json`) — the op vocabulary

Declarative, interpreted by the runner. **Nothing here is ever executed as code.** `{{data.key}}` placeholders are bound per run against that run's `data` only.

```jsonc
{
  "version": 3,
  "engine_min_version": "1.0.0",
  "playbook_type": "extraction",            // mirrors meta
  "output_format": { },                     // saved caller format; null for action type
  "required_data_keys": ["license_number", "last_name"],
  "steps": [
    { "op": "goto",     "url": "https://board/lookup" },
    { "op": "click",    "selector": "a[href*='lookup']", "description": "open lookup form",
      "fallback_selectors": ["text=License Lookup"] },
    { "op": "fill",     "selector": "#licNum", "value": "{{data.license_number}}" },
    { "op": "fill",     "selector": "#lastNm", "value": "{{data.last_name}}" },
    { "op": "select",   "selector": "#type",   "value": "Physician" },   // literal: process, not input
    { "op": "click",    "selector": "button[type=submit]" },
    { "op": "wait_for", "selector": ".results-table", "timeout_ms": 15000 },
    { "op": "extract",  "schema_ref": "output_format", "scope_selector": ".results-table" }
  ],
  "assertions": [
    { "after_step": 5, "expect": "url_matches", "pattern": "results" }
  ]
}
```

### Op vocabulary (v1)

| op | required fields | optional | notes |
|---|---|---|---|
| `goto` | `url` | | navigate |
| `click` | `selector` | `fallback_selectors`, `description` | |
| `fill` | `selector`, `value` | `fallback_selectors` | `value` may be `{{data.*}}` or a literal |
| `select` | `selector`, `value` | `fallback_selectors` | dropdown option |
| `check` | `selector` | `fallback_selectors` | checkbox/radio |
| `press` | `key` | `selector` | keyboard key |
| `wait_for` | `selector` | `timeout_ms` | |
| `wait_ms` | `ms` | | fixed wait (use sparingly) |
| `scroll` | | `selector`, `to` | |
| `extract` | `schema_ref` | `scope_selector` | binds to `output_format`; extraction-type only |
| `screenshot` | | `label` | evidence aid |

Each step records `description` (agent intent) and optional `fallback_selectors` (alternates from `observe()`), tried before declaring `step_failed`. **Parameterization is by value provenance, not text match** (`ARCHITECTURE.md` §4) — a `data` value becomes `{{data.key}}`; an agent-chosen literal (e.g. selecting "Physician") is stored literally.

### JSON Schema (validate every playbook body on load and on compile)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PlaybookVersion",
  "type": "object",
  "required": ["version", "engine_min_version", "playbook_type", "steps", "required_data_keys"],
  "additionalProperties": false,
  "properties": {
    "version": { "type": "integer", "minimum": 1 },
    "engine_min_version": { "type": "string" },
    "playbook_type": { "enum": ["extraction", "action"] },
    "output_format": { "type": ["object", "null"] },
    "required_data_keys": { "type": "array", "items": { "type": "string" } },
    "steps": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/step" } },
    "assertions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["expect"],
        "properties": {
          "after_step": { "type": "integer", "minimum": 0 },
          "expect": { "enum": ["url_matches", "selector_present", "selector_absent"] },
          "pattern": { "type": "string" },
          "selector": { "type": "string" }
        }
      }
    }
  },
  "$defs": {
    "step": {
      "type": "object",
      "required": ["op"],
      "properties": {
        "op": { "enum": ["goto","click","fill","select","check","press","wait_for","wait_ms","scroll","extract","screenshot"] },
        "url": { "type": "string" },
        "selector": { "type": "string" },
        "fallback_selectors": { "type": "array", "items": { "type": "string" } },
        "value": { "type": "string" },
        "key": { "type": "string" },
        "ms": { "type": "integer", "minimum": 0 },
        "timeout_ms": { "type": "integer", "minimum": 0 },
        "to": { "type": "string" },
        "scope_selector": { "type": "string" },
        "schema_ref": { "const": "output_format" },
        "label": { "type": "string" },
        "description": { "type": "string" }
      },
      "additionalProperties": false
    }
  }
}
```

> The interpreter MUST reject any body that fails this schema (an unknown `op`, a missing required field) rather than attempt a best-effort run — a malformed playbook is a `step_failed`/`internal_error`, never a guess. Keep this schema and the interpreter's op handlers in lockstep; adding an op means updating both in the same commit.

## 5. Evidence layout

```
evidence/
  {run_id}/
    screenshot.png
    page.html
    trace.zip        # only if CONFIG_TRACE=true
```

Keyed by `run_id` — never a shared/`latest.*` path (concurrency safety, `ARCHITECTURE.md` §8.1). The envelope carries signed expiring URLs (S3) or engine-served paths (local). Retention is the deployer's concern; the engine never deletes evidence.
