import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../../src/shared/envelope';

const META_KEYS = [
  'run_id',
  'status',
  'mode',
  'playbook_id',
  'playbook_version',
  'playbook_type',
  'self_healed',
  'llm_fallback_used',
  'fallback_fields',
  'duration_ms',
  'started_at',
  'finished_at',
  'evidence',
  'effective_config',
  'error',
  'extraction_errors',
];

describe('buildEnvelope (envelope invariants)', () => {
  it('emits every meta field, with null/false defaults, and result null', () => {
    const env = buildEnvelope({ run_id: 'run_x', status: 'queued', effective_config: { headless: true } });
    for (const k of META_KEYS) expect(env.meta).toHaveProperty(k);
    expect(env.meta.run_id).toBe('run_x');
    expect(env.meta.status).toBe('queued');
    expect(env.meta.mode).toBeNull();
    expect(env.meta.self_healed).toBe(false);
    expect(env.meta.llm_fallback_used).toBe(false);
    expect(env.meta.error).toBeNull();
    expect(env.meta.extraction_errors).toBeNull();
    expect(env.meta.effective_config).toEqual({ headless: true });
    expect(env.result).toBeNull();
  });

  it('result is only the caller shape or null — passed through unchanged', () => {
    const env = buildEnvelope({ run_id: 'r', status: 'completed', effective_config: {} }, { foo: 'bar' });
    expect(env.result).toEqual({ foo: 'bar' });
  });

  it('a failed run carries the §7 error', () => {
    const env = buildEnvelope({
      run_id: 'r',
      status: 'failed',
      effective_config: {},
      error: { code: 'internal_error', message: 'execution not implemented (Phase 1 skeleton)' },
    });
    expect(env.meta.status).toBe('failed');
    expect(env.meta.error?.code).toBe('internal_error');
  });
});
