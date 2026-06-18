/**
 * Free-text redaction for `data` values (PROJECT_SPEC §13, ARCHITECTURE §9). The structured logger
 * already censors the `data` object by path; this masks values that can slip into *free text* — e.g.
 * a Stagehand log line echoing what was typed into a field. Persisted surfaces are protected
 * structurally (run rows store keys not values; playbook bodies hold only `{{data.*}}`); this covers
 * the log/trace surface. Verified end-to-end by the no-leak scan.
 */
const CENSOR = '[redacted]';

/**
 * Build a redactor that masks any of `values` wherever they appear in a string. Values shorter than 3
 * chars are skipped — they're too collision-prone to mask without garbling unrelated text (and a
 * 1–2 char secret isn't a meaningful leak).
 */
export function makeValueRedactor(values: ReadonlyArray<string | number | boolean>): (text: string) => string {
  const needles = [...new Set(values.map((v) => String(v)))].filter((s) => s.length >= 3);
  if (needles.length === 0) return (text) => text;
  // Mask longest-first so an overlapping shorter value can't pre-empt a longer one.
  needles.sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const n of needles) {
      if (out.includes(n)) out = out.split(n).join(CENSOR);
    }
    return out;
  };
}
