import { describe, it, expect } from 'vitest';
import { healPolicyForError, shouldHealExtractionMiss } from '../../src/orchestrator/heal';
import { ERROR_CODES } from '../../src/types/errors';
import type { ErrorCode } from '../../src/types/errors';

// The §7 table, encoded once here as the source of truth for the test. If a code's policy changes,
// it changes in exactly one place (the implementation) and this asserts it — and ERROR_CODES
// coverage below guarantees no code is left unclassified.
const EXPECTED: Record<ErrorCode, { off: string; on: string }> = {
  step_failed: { off: 'heal', on: 'heal' },
  navigation_failed: { off: 'heal', on: 'heal' },
  extraction_failed: { off: 'none', on: 'heal' }, // flips only with self_heal_on_extraction_failure
  browser_crashed: { off: 'infra_retry', on: 'infra_retry' },
  captcha_detected: { off: 'none', on: 'none' },
  timeout: { off: 'none', on: 'none' },
  validation_error: { off: 'none', on: 'none' },
  playbook_not_found: { off: 'none', on: 'none' },
  agent_gave_up: { off: 'none', on: 'none' },
  internal_error: { off: 'none', on: 'none' },
};

describe('healPolicyForError — the §7 heal-eligibility table', () => {
  it('classifies every error code exactly per spec (both config states)', () => {
    for (const code of ERROR_CODES) {
      expect(healPolicyForError(code, { selfHealOnExtractionFailure: false }), `${code} (off)`).toBe(EXPECTED[code].off);
      expect(healPolicyForError(code, { selfHealOnExtractionFailure: true }), `${code} (on)`).toBe(EXPECTED[code].on);
    }
  });

  it('covers the entire ERROR_CODES set (no code left unclassified)', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ERROR_CODES].sort());
  });

  it('only extraction_failed is config-sensitive', () => {
    const flips = ERROR_CODES.filter(
      (c) =>
        healPolicyForError(c, { selfHealOnExtractionFailure: false }) !==
        healPolicyForError(c, { selfHealOnExtractionFailure: true }),
    );
    expect(flips).toEqual(['extraction_failed']);
  });

  it('extraction-miss escalates only when self_heal_on_extraction_failure is set', () => {
    expect(shouldHealExtractionMiss({ selfHealOnExtractionFailure: true })).toBe(true);
    expect(shouldHealExtractionMiss({ selfHealOnExtractionFailure: false })).toBe(false);
  });
});
