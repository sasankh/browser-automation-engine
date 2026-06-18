import { describe, it, expect } from 'vitest';
import { ProvenanceIndex } from '../../src/execution/agent/provenance';

describe('ProvenanceIndex — value-identity tagging (not page-text scan)', () => {
  it('tags a typed value back to its data key by exact identity', () => {
    const idx = new ProvenanceIndex({ license_number: 'A123456', last_name: 'Nguyen' });
    expect(idx.tag('A123456')).toBe('license_number');
    expect(idx.tag('Nguyen')).toBe('last_name');
  });

  it('returns null for an agent-chosen literal that is not a data value', () => {
    const idx = new ProvenanceIndex({ license_number: 'A123456' });
    // "Physician" is a process literal the agent picked; it must NOT be templated.
    expect(idx.tag('Physician')).toBeNull();
  });

  it('does not templatize a value just because it also appears as page text', () => {
    // The results page renders the literal text "active"; if it is NOT a data value, never tag it.
    const idx = new ProvenanceIndex({ license_number: 'A123456' });
    expect(idx.tag('active')).toBeNull();
  });

  it('matches stringified numbers and booleans', () => {
    const idx = new ProvenanceIndex({ year: 2020, active: true });
    expect(idx.tag('2020')).toBe('year');
    expect(idx.tag('true')).toBe('active');
  });

  it('refuses to tag an ambiguous value that maps to multiple keys', () => {
    const idx = new ProvenanceIndex({ a: 'same', b: 'same' });
    expect(idx.tag('same')).toBeNull();
  });

  it('never tags the empty string', () => {
    const idx = new ProvenanceIndex({ blank: '' });
    expect(idx.tag('')).toBeNull();
  });
});
