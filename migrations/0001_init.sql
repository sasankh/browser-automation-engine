-- Phase 1 — core schema (ARCHITECTURE §5.1 / DATA_MODEL §2). Append-only, numbered; never edit in place.

CREATE TABLE IF NOT EXISTS playbooks (
  id                         TEXT PRIMARY KEY,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  url                        TEXT NOT NULL,
  instruction                TEXT NOT NULL,
  playbook_type              TEXT NOT NULL,
  required_data_keys         TEXT[] NOT NULL DEFAULT '{}',
  active_version             INT  NOT NULL,
  health                     TEXT NOT NULL DEFAULT 'healthy',
  consecutive_heal_failures  INT  NOT NULL DEFAULT 0,
  deleted                    BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS playbook_versions (
  playbook_id    TEXT NOT NULL REFERENCES playbooks(id),
  version        INT  NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     TEXT NOT NULL,
  created_by_run TEXT,
  output_format  JSONB,
  body_uri       TEXT NOT NULL,
  PRIMARY KEY (playbook_id, version)
);

CREATE TABLE IF NOT EXISTS runs (
  id                 TEXT PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  status             TEXT NOT NULL,
  mode               TEXT,
  playbook_id        TEXT,
  playbook_version   INT,
  self_healed        BOOLEAN NOT NULL DEFAULT false,
  llm_fallback_used  BOOLEAN NOT NULL DEFAULT false,
  effective_config   JSONB NOT NULL,
  error              JSONB,
  extraction_errors  JSONB,
  data_keys          TEXT[] NOT NULL DEFAULT '{}',
  evidence_uri       TEXT,
  callback_url       TEXT,
  webhook_status     TEXT,
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  caller          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id          TEXT NOT NULL REFERENCES runs(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caller, idempotency_key)
);
