import { describe, it, expect } from 'vitest';
import { PayloadSchema } from '../../src/intake/payload-schema';

describe('PayloadSchema (accept/reject matrix)', () => {
  it('accepts a playbook replay payload', () => {
    expect(PayloadSchema.safeParse({ playbook_id: 'pb_x', data: { license_number: 'A1' } }).success).toBe(true);
  });

  it('accepts an instruction+url payload', () => {
    expect(
      PayloadSchema.safeParse({ instruction: 'do it', url: 'http://x', output_format: { a: 'string' } }).success,
    ).toBe(true);
  });

  it('rejects when neither playbook_id nor instruction+url present (resolution precondition)', () => {
    expect(PayloadSchema.safeParse({ data: { a: 1 } }).success).toBe(false);
  });

  it('rejects instruction without url', () => {
    expect(PayloadSchema.safeParse({ instruction: 'do it' }).success).toBe(false);
  });

  it('accepts scalar data values (string/number/boolean)', () => {
    expect(PayloadSchema.safeParse({ playbook_id: 'pb_x', data: { s: 'x', n: 1, b: true } }).success).toBe(true);
  });

  it('rejects non-scalar data values', () => {
    expect(PayloadSchema.safeParse({ playbook_id: 'pb_x', data: { a: { nested: true } } }).success).toBe(false);
  });

  it('accepts a valid config override', () => {
    expect(
      PayloadSchema.safeParse({ playbook_id: 'pb_x', config: { playbook_self_heal: false, model: 'ollama/llama3.1' } })
        .success,
    ).toBe(true);
  });
});
