-- Phase 7 — opt-in raw-input retention for debugging. Default OFF: runs store data KEYS, not values
-- (the secure default). Only populated when STORE_RUN_INPUTS=true. Append-only; never edit in place.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS data_values JSONB;
