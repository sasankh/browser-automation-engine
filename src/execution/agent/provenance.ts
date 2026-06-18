import type { RunData } from '../playbook/step-interpreter';
import { stringifyDataValue } from './recorded-action';

/**
 * Value → key reverse index over THIS run's `data` (ARCHITECTURE §4). Provenance is by **exact value
 * identity tracked through the agent's calls**, never by scanning page text — so a `data` value that
 * also happens to appear as static page text is never mis-templated. The orchestrator builds one of
 * these before the run; the recorder tags each typed value against it.
 */
export class ProvenanceIndex {
  /** stringified data value → data key. */
  private readonly valueToKey = new Map<string, string>();
  /** Values that map to more than one key — ambiguous, so we refuse to templatize them. */
  private readonly ambiguous = new Set<string>();

  constructor(data: RunData) {
    for (const [key, raw] of Object.entries(data)) {
      const value = stringifyDataValue(raw);
      if (value === '') continue; // never templatize an empty value — too collision-prone
      if (this.valueToKey.has(value) && this.valueToKey.get(value) !== key) {
        this.ambiguous.add(value);
      } else {
        this.valueToKey.set(value, key);
      }
    }
  }

  /**
   * Return the `data` key a typed value came from, or `null` if it's an agent-chosen literal (or an
   * ambiguous value that maps to multiple keys). The match is exact string identity — the agent typed
   * this exact value, we link it back to its source key.
   */
  tag(typedValue: string): string | null {
    if (this.ambiguous.has(typedValue)) return null;
    return this.valueToKey.get(typedValue) ?? null;
  }
}
