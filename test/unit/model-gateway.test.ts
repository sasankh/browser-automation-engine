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
