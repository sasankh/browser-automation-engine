import type { Envelope, Meta, Evidence } from '../types/envelope';
import type { RunStatus, RunMode, PlaybookType } from '../types/run';
import type { RunError, ExtractionError } from '../types/errors';

export interface BuildEnvelopeInput {
  run_id: string;
  status: RunStatus;
  effective_config: Record<string, unknown>;
  mode?: RunMode | null;
  playbook_id?: string | null;
  playbook_version?: number | null;
  playbook_type?: PlaybookType | null;
  self_healed?: boolean;
  llm_fallback_used?: boolean;
  fallback_fields?: string[] | null;
  duration_ms?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  evidence?: Evidence | null;
  error?: RunError | null;
  extraction_errors?: ExtractionError[] | null;
}

/**
 * Build the universal `{ meta, result }` envelope (PROJECT_SPEC §6). `result` is ONLY ever the
 * caller's output_format shape or null — the engine never injects a field into it. All system
 * info lives in `meta`.
 */
export function buildEnvelope(
  input: BuildEnvelopeInput,
  result: Record<string, unknown> | null = null,
): Envelope {
  const meta: Meta = {
    run_id: input.run_id,
    status: input.status,
    mode: input.mode ?? null,
    playbook_id: input.playbook_id ?? null,
    playbook_version: input.playbook_version ?? null,
    playbook_type: input.playbook_type ?? null,
    self_healed: input.self_healed ?? false,
    llm_fallback_used: input.llm_fallback_used ?? false,
    fallback_fields: input.fallback_fields ?? null,
    duration_ms: input.duration_ms ?? null,
    started_at: input.started_at ?? null,
    finished_at: input.finished_at ?? null,
    evidence: input.evidence ?? null,
    effective_config: input.effective_config,
    error: input.error ?? null,
    extraction_errors: input.extraction_errors ?? null,
  };
  return { meta, result };
}
