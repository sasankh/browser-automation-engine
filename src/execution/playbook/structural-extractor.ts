import type { Page } from 'playwright';
import type { Step } from './playbook-schema';
import type { ExtractionError } from '../../types/errors';

export interface ExtractionResult {
  result: Record<string, unknown> | null;
  extractionErrors: ExtractionError[];
}

/**
 * Pull each `output_format` field from the DOM via the extract op's `fields` map (DECISIONS #14):
 * field → selector relative to `scope_selector`. A field that lacks a selector or can't be located
 * is reported in `extraction_errors` and left `null` in the result — never guessed (honest results).
 */
export async function structuralExtract(
  page: Page,
  step: Step,
  outputFormat: Record<string, unknown> | null | undefined,
): Promise<ExtractionResult> {
  if (!outputFormat) return { result: null, extractionErrors: [] };

  const fields = step.fields ?? {};
  const scope = step.scope_selector;
  const result: Record<string, unknown> = {};
  const errors: ExtractionError[] = [];

  for (const field of Object.keys(outputFormat)) {
    const sel = fields[field];
    if (!sel) {
      result[field] = null;
      errors.push({ field, reason: 'no_selector_in_playbook' });
      continue;
    }
    const fullSelector = scope ? `${scope} ${sel}` : sel;
    try {
      const loc = page.locator(fullSelector).first();
      if ((await loc.count()) === 0) {
        result[field] = null;
        errors.push({ field, reason: 'not_found_on_page' });
        continue;
      }
      const text = (await loc.innerText()).trim();
      result[field] = coerce(text, outputFormat[field]);
    } catch {
      result[field] = null;
      errors.push({ field, reason: 'not_found_on_page' });
    }
  }

  return { result, extractionErrors: errors };
}

/** Light coercion driven by the output_format type hint; unknown hints stay as strings. */
function coerce(text: string, hint: unknown): unknown {
  const h = typeof hint === 'string' ? hint.toLowerCase() : '';
  if (h.startsWith('number')) {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  if (h.startsWith('boolean')) return text.toLowerCase() === 'true';
  return text;
}
