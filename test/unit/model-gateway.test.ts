import { describe, it, expect } from 'vitest';
import { ModelGateway, ModelConfigError } from '../../src/model/model-gateway';

function gateway(env: Record<string, string> = {}): ModelGateway {
  return new ModelGateway(env as NodeJS.ProcessEnv);
}

describe('ModelGateway — provider/name resolution + require-explicit (DECISIONS #11)', () => {
  it('resolves an Anthropic model with the env key', () => {
    const r = gateway({ ANTHROPIC_API_KEY: 'sk-test' }).resolve('anthropic/claude-sonnet-4-6');
    expect(r.provider).toBe('anthropic');
    expect(r.modelId).toBe('claude-sonnet-4-6');
    expect(r.modelString).toBe('anthropic/claude-sonnet-4-6');
    expect(r.apiKey).toBe('sk-test');
    // Pin the /v1 endpoint (Stagehand v3.5 otherwise 404s at /messages) — env-overridable.
    expect(r.baseURL).toBe('https://api.anthropic.com/v1');
  });

  it('honors an ANTHROPIC_BASE_URL override that already has /v1', () => {
    const r = gateway({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'https://proxy/v1' }).resolve('anthropic/claude-sonnet-4-6');
    expect(r.baseURL).toBe('https://proxy/v1');
  });

  it('normalizes a ROOT ANTHROPIC_BASE_URL (Anthropic-SDK convention) to the AI-SDK /v1 endpoint', () => {
    const r = gateway({ ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }).resolve('anthropic/claude-sonnet-4-6');
    expect(r.baseURL).toBe('https://api.anthropic.com/v1');
  });

  it('require-explicit: a null/empty model is no_model (→ validation_error upstream)', () => {
    expect(() => gateway().resolve(null)).toThrowError(ModelConfigError);
    try {
      gateway().resolve(null);
    } catch (e) {
      expect((e as ModelConfigError).reason).toBe('no_model');
    }
  });

  it('rejects a malformed model string (no provider prefix)', () => {
    try {
      gateway({ ANTHROPIC_API_KEY: 'x' }).resolve('claude-sonnet-4-6');
    } catch (e) {
      expect((e as ModelConfigError).reason).toBe('malformed');
    }
  });

  it('rejects an unsupported provider', () => {
    try {
      gateway({}).resolve('cohere/command-r');
    } catch (e) {
      expect((e as ModelConfigError).reason).toBe('unsupported_provider');
    }
  });

  it('rejects a supported provider whose key is absent (env-only secret)', () => {
    try {
      gateway({}).resolve('anthropic/claude-sonnet-4-6');
    } catch (e) {
      expect((e as ModelConfigError).reason).toBe('missing_key');
    }
  });

  it('resolves keyless Ollama via OLLAMA_BASE_URL (no key needed)', () => {
    const r = gateway({ OLLAMA_BASE_URL: 'http://localhost:11434' }).resolve('ollama/qwen3:1.7b');
    expect(r.provider).toBe('ollama');
    expect(r.apiKey).toBeUndefined();
    expect(r.baseURL).toBe('http://localhost:11434');
  });

  it('Ollama without a base URL is missing_key (needs an endpoint)', () => {
    try {
      gateway({}).resolve('ollama/qwen3:1.7b');
    } catch (e) {
      expect((e as ModelConfigError).reason).toBe('missing_key');
    }
  });
});
