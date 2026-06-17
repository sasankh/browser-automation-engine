-- Persist the extracted result so GET /v1/runs/{id} can return it on poll (the envelope's `result`).
-- DATA_MODEL §2 omitted this column; added here. Append-only migration.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS result JSONB;
