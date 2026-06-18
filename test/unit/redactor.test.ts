import { describe, it, expect } from 'vitest';
import { makeValueRedactor } from '../../src/shared/redactor';

describe('makeValueRedactor — free-text data redaction', () => {
  it('masks data values wherever they appear', () => {
    const r = makeValueRedactor(['A123456', 'Nguyen']);
    expect(r('typed A123456 into #licNum and Nguyen into #lastNm')).toBe(
      'typed [redacted] into #licNum and [redacted] into #lastNm',
    );
  });

  it('skips values shorter than 3 chars (too collision-prone to mask)', () => {
    const r = makeValueRedactor(['ab', '42']);
    expect(r('ab 42 unchanged')).toBe('ab 42 unchanged');
  });

  it('coerces numbers/booleans and is a no-op for an empty set', () => {
    expect(makeValueRedactor([2020, true])('year 2020 active true')).toBe('year [redacted] active [redacted]');
    expect(makeValueRedactor([])('nothing to mask')).toBe('nothing to mask');
  });

  it('masks longest-first so an overlapping shorter value cannot garble a longer one', () => {
    const r = makeValueRedactor(['secret', 'secretvalue']);
    expect(r('the secretvalue here')).toBe('the [redacted] here');
  });
});
