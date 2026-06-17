import type { RecordedAction, ExtractionFields } from './recorded-action';
import type { PlaybookVersion, Step } from '../playbook/playbook-schema';
import { parsePlaybookVersion } from '../playbook/playbook-schema';

export interface CompileInput {
  recorded: RecordedAction[];
  /** Caller's desired result shape; absent ⇒ an action-only playbook (no extract step, result null). */
  outputFormat: Record<string, unknown> | null;
  /** Extraction field → selector (extraction tasks only), surfaced by the agent. */
  extractionFields?: ExtractionFields | null;
  /** Optional shared ancestor selector the extraction fields are relative to. */
  scopeSelector?: string | null;
}

/**
 * Turn a recorded agent action stream into a declarative `vN.json` the Phase-2 runner replays
 * (ARCHITECTURE §4.2). Data-provenanced values become `{{data.key}}`; agent-chosen literals are baked
 * in verbatim (process, not input). `required_data_keys` is the provenance set; `output_format` is
 * attached verbatim; an extraction task gets a trailing `extract` step. The result is validated
 * against the Phase-2 schema before return — a compiler that emits an invalid playbook is a bug, not
 * a best-effort run.
 */
export function compilePlaybook(input: CompileInput): PlaybookVersion {
  const { recorded, outputFormat } = input;
  const steps: Step[] = [];
  const requiredKeys: string[] = [];

  for (const action of recorded) {
    if (action.dataProvenance && !requiredKeys.includes(action.dataProvenance)) {
      requiredKeys.push(action.dataProvenance);
    }
    steps.push(toStep(action));
  }

  const isExtraction = outputFormat !== null && outputFormat !== undefined;
  if (isExtraction) {
    const fields = input.extractionFields ?? {};
    const extractStep: Step = {
      op: 'extract',
      schema_ref: 'output_format',
      fields,
    };
    if (input.scopeSelector) extractStep.scope_selector = input.scopeSelector;
    steps.push(extractStep);
  }

  const body: PlaybookVersion = {
    version: 1,
    engine_min_version: '1.0.0',
    playbook_type: isExtraction ? 'extraction' : 'action',
    output_format: outputFormat ?? null,
    required_data_keys: requiredKeys,
    steps,
  };

  // Validate against the Phase-2 schema — guarantees the runner can replay what we just compiled.
  return parsePlaybookVersion(body);
}

/** Map one recorded action to a declarative step; parameterize provenanced fill/select values. */
function toStep(action: RecordedAction): Step {
  const step: Step = { op: action.op };
  if (action.url !== undefined) step.url = action.url;
  if (action.selector !== undefined) step.selector = action.selector;
  if (action.fallbackSelectors && action.fallbackSelectors.length > 0) {
    step.fallback_selectors = action.fallbackSelectors;
  }
  if (action.key !== undefined) step.key = action.key;
  if (action.description !== undefined) step.description = action.description;

  if (action.op === 'fill' || action.op === 'select') {
    const raw = action.value ?? '';
    // Provenanced → {{data.key}}; literal → baked in verbatim (it's process, not input).
    step.value = action.dataProvenance ? `{{data.${action.dataProvenance}}}` : raw;
  }
  return step;
}
