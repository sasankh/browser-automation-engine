import type { Db } from '../db';
import { buildEnvelope } from '../../shared/envelope';
import type { Envelope } from '../../types/envelope';
import type { RunError, ExtractionError } from '../../types/errors';
import type { RunStatus, RunMode, PlaybookType } from '../../types/run';

export interface CreateRunInput {
  id: string;
  effectiveConfig: Record<string, unknown>;
  dataKeys: string[];
  callbackUrl: string | null;
}

interface RunRow {
  id: string;
  status: RunStatus;
  mode: RunMode | null;
  playbook_id: string | null;
  playbook_version: number | null;
  playbook_type: PlaybookType | null;
  self_healed: boolean;
  llm_fallback_used: boolean;
  effective_config: Record<string, unknown>;
  error: RunError | null;
  extraction_errors: ExtractionError[] | null;
  evidence_uri: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

export class RunStore {
  constructor(private readonly db: Db) {}

  async createRun(input: CreateRunInput): Promise<void> {
    await this.db.query(
      `INSERT INTO runs (id, status, effective_config, data_keys, callback_url)
       VALUES ($1, 'queued', $2, $3, $4)`,
      [input.id, input.effectiveConfig, input.dataKeys, input.callbackUrl],
    );
  }

  async markRunning(id: string): Promise<void> {
    await this.db.query(`UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`, [id]);
  }

  async markFailed(id: string, error: RunError): Promise<void> {
    await this.db.query(
      `UPDATE runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [id, error],
    );
  }

  async deleteRun(id: string): Promise<void> {
    await this.db.query(`DELETE FROM runs WHERE id = $1`, [id]);
  }

  async getEnvelope(id: string): Promise<Envelope | null> {
    const res = await this.db.query<RunRow>(`SELECT * FROM runs WHERE id = $1`, [id]);
    const row = res.rows[0];
    if (!row) return null;
    const durationMs =
      row.started_at && row.finished_at
        ? row.finished_at.getTime() - row.started_at.getTime()
        : null;
    return buildEnvelope({
      run_id: row.id,
      status: row.status,
      effective_config: row.effective_config,
      mode: row.mode,
      playbook_id: row.playbook_id,
      playbook_version: row.playbook_version,
      playbook_type: row.playbook_type,
      self_healed: row.self_healed,
      llm_fallback_used: row.llm_fallback_used,
      error: row.error,
      extraction_errors: row.extraction_errors,
      duration_ms: durationMs,
      started_at: row.started_at ? row.started_at.toISOString() : null,
      finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    });
  }
}
