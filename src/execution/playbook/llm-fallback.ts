import { z } from 'zod';
import type { ModelGateway } from '../../model/model-gateway';

/**
 * The surfaced LLM extraction fallback (ARCHITECTURE §6.3, PROJECT_SPEC §9.2). When the deterministic
 * structural extractor misses ≥1 field AND `REPLAY_LLM_FALLBACK=on`, the runner asks this to resolve
 * ONLY the missing fields from the page content via the `ModelGateway` (the one sanctioned model call
 * on the replay path). It is an interface so the runner's fallback path is unit-testable offline with
 * a stub — the real impl calls a live model.
 */
export interface FallbackRequest {
  /** Visible page text (cleaner + cheaper than raw HTML). */
  pageText: string;
  /** Full output_format (carries the type hints). */
  outputFormat: Record<string, unknown>;
  /** Fields the structural extractor could not locate. */
  missingFields: string[];
  /** `REPLAY_LLM_FALLBACK_MODEL` (`provider/name`, require-explicit). */
  model: string | null;
}

export interface FallbackResponse {
  /** field → value for fields the model resolved; a field it can't find is simply omitted (never guessed). */
  resolved: Record<string, unknown>;
}

export interface LlmExtractFallback {
  extract(req: FallbackRequest): Promise<FallbackResponse>;
}

/** Real implementation: one `generateObject` call through the `ModelGateway`. */
export class ModelGatewayFallback implements LlmExtractFallback {
  constructor(private readonly gateway: ModelGateway) {}

  async extract(req: FallbackRequest): Promise<FallbackResponse> {
    const schema = buildSchema(req.missingFields, req.outputFormat);
    const obj = await this.gateway.extractObject({
      model: req.model,
      schema,
      prompt: buildPrompt(req.pageText, req.missingFields, req.outputFormat),
    });
    // Honest results: keep only fields the model actually resolved (non-null/non-empty), never guessed.
    const resolved: Record<string, unknown> = {};
    for (const field of req.missingFields) {
      const v = obj[field];
      if (v !== null && v !== undefined && v !== '') resolved[field] = v;
    }
    return { resolved };
  }
}

/** A schema over only the missing fields, each nullable so the model can say "not present". */
function buildSchema(fields: string[], outputFormat: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    shape[field] = zodForHint(outputFormat[field]).nullable();
  }
  return z.object(shape) as unknown as z.ZodType<Record<string, unknown>>;
}

function zodForHint(hint: unknown): z.ZodTypeAny {
  const h = typeof hint === 'string' ? hint.toLowerCase() : '';
  if (h.startsWith('number')) return z.number();
  if (h.startsWith('boolean')) return z.boolean();
  if (h.startsWith('array')) return z.array(z.string());
  return z.string();
}

function buildPrompt(pageText: string, fields: string[], outputFormat: Record<string, unknown>): string {
  const wanted = fields
    .map((f) => `- ${f} (${typeof outputFormat[f] === 'string' ? String(outputFormat[f]) : 'string'})`)
    .join('\n');
  return [
    'Extract the following fields from the page content below.',
    'Return null for any field that is not present. Do not guess or invent values.',
    '',
    'Fields:',
    wanted,
    '',
    'Page content:',
    pageText.slice(0, 16_000),
  ].join('\n');
}
