import { describe, it, expect } from 'vitest';
import { resolveBehaviorConfig } from '../../src/intake/config-resolver';
import type { PayloadConfig } from '../../src/intake/payload-schema';

const OPTS = { maxRunTimeoutSeconds: 600 };

describe('resolveBehaviorConfig (payload > env > default)', () => {
  it('uses built-in defaults when neither payload nor env set', () => {
    const c = resolveBehaviorConfig(undefined, {}, OPTS);
    expect(c.playbook_self_heal).toBe(true);
    expect(c.self_heal_on_extraction_failure).toBe(false);
    expect(c.run_timeout_seconds).toBe(180);
    expect(c.agent_max_steps).toBe(25);
    expect(c.evidence_capture).toBe(true);
    expect(c.headless).toBe(true);
    expect(c.replay_llm_fallback).toBe('off');
  });

  it('env overrides the built-in default', () => {
    const c = resolveBehaviorConfig(
      undefined,
      { CONFIG_PLAYBOOK_SELF_HEAL: 'false', RUN_TIMEOUT_SECONDS: '60', CONFIG_MODEL: 'anthropic/claude-x' },
      OPTS,
    );
    expect(c.playbook_self_heal).toBe(false);
    expect(c.run_timeout_seconds).toBe(60);
    expect(c.model).toBe('anthropic/claude-x');
  });

  it('payload overrides env and default', () => {
    const c = resolveBehaviorConfig(
      { playbook_self_heal: true, run_timeout_seconds: 30, model: 'openai/gpt-4.1' },
      { CONFIG_PLAYBOOK_SELF_HEAL: 'false', RUN_TIMEOUT_SECONDS: '60', CONFIG_MODEL: 'anthropic/claude-x' },
      OPTS,
    );
    expect(c.playbook_self_heal).toBe(true);
    expect(c.run_timeout_seconds).toBe(30);
    expect(c.model).toBe('openai/gpt-4.1');
  });

  it('caps run_timeout_seconds at maxRunTimeoutSeconds', () => {
    const c = resolveBehaviorConfig({ run_timeout_seconds: 9999 }, {}, { maxRunTimeoutSeconds: 300 });
    expect(c.run_timeout_seconds).toBe(300);
  });

  it('model has NO built-in default (require-explicit, DECISIONS #11)', () => {
    expect(resolveBehaviorConfig(undefined, {}, OPTS).model).toBeNull();
  });

  it('ignores env-only keys smuggled into payload config', () => {
    const smuggled = { MAX_CONCURRENT_RUNS: 99 } as unknown as PayloadConfig;
    const c = resolveBehaviorConfig(smuggled, {}, OPTS) as unknown as Record<string, unknown>;
    expect(c.MAX_CONCURRENT_RUNS).toBeUndefined();
  });
});
