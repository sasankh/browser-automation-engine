import type { Db } from '../db';
import { buildEnvelope } from '../../shared/envelope';
import type { Envelope, Evidence } from '../../types/envelope';
import type { RunError, ExtractionError } from '../../types/errors';
import type { RunStatus, RunMode, PlaybookType } from '../../types/run';

export interface CreateRunInput {
  id: string;
  effectiveConfig: Record<string, unknown>;
  dataKeys: string[];
  callbackUrl: string | null;
  mode?: RunMode | null;
  playbookId?: string | null;
  playbookVersion?: number | null;
}

export interface FinishRunInput {
  status: RunStatus;
  result?: Record<string, unknown> | null;
  error?: RunError | null;
  extractionErrors?: ExtractionError[] | null;
  evidenceCaptured?: boolean;
  /** Agent runs learn a playbook during the run — record it on finish (replay runs leave these unset). */
  playbookId?: string | null;
  playbookVersion?: number | null;
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
  result: Record<string, unknown> | null;
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
      `INSERT INTO runs (id, status, mode, playbook_id, playbook_version, effective_config, data_keys, callback_url)
       VALUES ($1, 'queued', $2, $3, $4, $5, $6, $7)`,
      [
        input.id,
        input.mode ?? null,
        input.playbookId ?? null,
        input.playbookVersion ?? null,
        input.effectiveConfig,
        input.dataKeys,
        input.callbackUrl,
      ],
    );
  }

  async markRunning(id: string): Promise<void> {
    await this.db.query(`UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`, [id]);
  }

  async finishRun(id: string, input: FinishRunInput): Promise<void> {
    const evidenceUri = input.evidenceCaptured ? `evidence/${id}` : null;
    // extraction_errors is an array → JSON.stringify so node-pg sends JSON, not a Postgres array literal.
    const extractionErrors = input.extractionErrors ? JSON.stringify(input.extractionErrors) : null;
    await this.db.query(
      `UPDATE runs
       SET status = $2, result = $3, error = $4, extraction_errors = $5, evidence_uri = $6,
           playbook_id = COALESCE($7, playbook_id),
           playbook_version = COALESCE($8, playbook_version),
           finished_at = now()
       WHERE id = $1`,
      [
        id,
        input.status,
        input.result ?? null,
        input.error ?? null,
        extractionErrors,
        evidenceUri,
        input.playbookId ?? null,
        input.playbookVersion ?? null,
      ],
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
    const evidence: Evidence | null = row.evidence_uri
      ? {
          screenshot_url: `/v1/runs/${id}/evidence/screenshot.png`,
          html_url: `/v1/runs/${id}/evidence/page.html`,
        }
      : null;
    return buildEnvelope(
      {
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
        evidence,
        duration_ms: durationMs,
        started_at: row.started_at ? row.started_at.toISOString() : null,
        finished_at: row.finished_at ? row.finished_at.toISOString() : null,
      },
      row.result,
    );
  }
}
