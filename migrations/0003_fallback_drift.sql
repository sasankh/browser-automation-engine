-- Phase 5 — surfaced LLM fallback drift signal + the run's resolved fallback fields.
-- Append-only, numbered; never edit in place.

-- Per-playbook count of LLM-fallback engagements (drift visibility). At FALLBACK_DRIFT_THRESHOLD,
-- FALLBACK_AS_DRIFT_SIGNAL flags the playbook health='needs_relearn' (surfaced via ?health=).
ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS fallback_engaged_count INT NOT NULL DEFAULT 0;

-- Which fields the LLM fallback resolved on a run (envelope meta.fallback_fields).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS fallback_fields JSONB;
