import type { RunError, ExtractionError } from './errors';
import type { RunStatus, RunMode, PlaybookType } from './run';

export interface Evidence {
  screenshot_url: string | null;
  html_url: string | null;
}

/**
 * Universal response meta. All system info lives here; new fields are additive only
 * (PROJECT_SPEC §6). `effective_config` echoes resolved behavior keys only (DECISIONS #13).
 */
export interface Meta {
  run_id: string;
  status: RunStatus;
  mode: RunMode | null;
  playbook_id: string | null;
  playbook_version: number | null;
  playbook_type: PlaybookType | null;
  self_healed: boolean;
  llm_fallback_used: boolean;
  fallback_fields: string[] | null;
  duration_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
  evidence: Evidence | null;
  effective_config: Record<string, unknown>;
  error: RunError | null;
  extraction_errors: ExtractionError[] | null;
  /** Webhook delivery outcome when a `callback_url` was given (Phase 6): `delivered` | `failed` | null. */
  webhook_status: string | null;
}

/** The universal envelope. `result` is ONLY ever the caller's output_format shape or null. */
export interface Envelope {
  meta: Meta;
  result: Record<string, unknown> | null;
}
