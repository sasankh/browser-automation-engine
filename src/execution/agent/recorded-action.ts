import type { RunData } from '../playbook/step-interpreter';

/**
 * The seam between the (LLM-driven) agent recorder and the (pure) compiler. An effective action the
 * agent performed, normalized to the Phase-2 op vocabulary, with provenance already resolved by
 * value identity (ARCHITECTURE §4) — NOT by scanning page text. The compiler turns a list of these
 * into a declarative playbook; nothing here imports Stagehand, so the compiler stays offline-testable.
 */
export interface RecordedAction {
  op: 'goto' | 'click' | 'fill' | 'select' | 'check' | 'press' | 'wait_for' | 'scroll';
  /** Target selector (absent for `goto`). */
  selector?: string;
  /** Alternates surfaced by `observe()`, tried in order at replay before failing. */
  fallbackSelectors?: string[];
  /** For `goto`. */
  url?: string;
  /** Raw value written by `fill`/`select`, exactly as typed (pre-templating). */
  value?: string;
  /** For `press`. */
  key?: string;
  /** Human-readable note from the agent (`observe()` description); compiled into the step's `description`. */
  description?: string;
  /**
   * The `data` key this value came from, resolved by exact value identity through the agent call.
   * `null`/absent ⇒ an agent-chosen literal (process, not input) — baked in verbatim, never templated.
   */
  dataProvenance?: string | null;
}

/** Field → selector map for an extraction step, surfaced by the agent (`observe()` per field). */
export type ExtractionFields = Record<string, string>;

/** What the agent engine hands the compiler + orchestrator after a learn run. */
export interface AgentLearnResult {
  recorded: RecordedAction[];
  /** Extraction field → selector (extraction tasks only). */
  extractionFields: ExtractionFields | null;
  /** Optional shared ancestor selector the extraction fields are relative to. */
  scopeSelector: string | null;
  /** The extracted result for THIS run (validated against output_format), or null for action tasks. */
  result: Record<string, unknown> | null;
  /** Fields the agent could not locate/extract (honest results). */
  extractionErrors: Array<{ field: string; reason: string }>;
  /** Token cost of the agent run, when the provider reports it (economics sanity, plan §risks). */
  usage: { inputTokens: number; outputTokens: number } | null;
}

/** Convenience: a data value stringified for identity comparison (numbers/booleans included). */
export function stringifyDataValue(v: RunData[string]): string {
  return String(v);
}
