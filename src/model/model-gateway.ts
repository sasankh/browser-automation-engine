import { generateObject } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { z } from 'zod';

/**
 * The single seam through which a `model` string (`provider/name`, DECISIONS #11) is resolved to a
 * concrete provider + its env-only secret, AND the only place provider SDKs are imported (ARCHITECTURE
 * §3.4, layering §3). The agent path hands the resolved model/key to Stagehand (which owns that call);
 * the Phase-5 surfaced `LlmExtractFallback` calls `extractObject()` here (Anthropic wired this phase;
 * other providers are a thin extension to `buildModel`).
 *
 * Two rules from DECISIONS #11 are enforced here:
 *  - **Require-explicit:** there is NO built-in default model. A run that needs a model with none
 *    resolved fails (`no_model`) → the orchestrator maps it to `validation_error`.
 *  - **Config flows one way:** the provider/model is chosen by behavior config, but the key/endpoint
 *    is **env-only** — a payload can pick a provider but never supply a secret or redirect an endpoint.
 */
export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'ollama';

const SUPPORTED: readonly ModelProvider[] = ['anthropic', 'openai', 'google', 'ollama'];

/** Env var holding each provider's API key; `null` for keyless local providers (Ollama). */
const PROVIDER_KEY_ENV: Record<ModelProvider, string | null> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  ollama: null,
};

export type ModelConfigReason = 'no_model' | 'malformed' | 'unsupported_provider' | 'missing_key';

/** A model-resolution failure. The orchestrator classifies every variant to `validation_error`. */
export class ModelConfigError extends Error {
  constructor(
    readonly reason: ModelConfigReason,
    message: string,
  ) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

export interface ResolvedModel {
  provider: ModelProvider;
  /** Bare model id, e.g. `claude-sonnet-4-6`. */
  modelId: string;
  /** Full `provider/name` string — what Stagehand's `model.modelName` expects. */
  modelString: string;
  /** Provider API key from env (undefined only for keyless local providers). */
  apiKey?: string;
  /** Optional base-URL override (Ollama / OpenAI-compatible), env-only. */
  baseURL?: string;
}

export class ModelGateway {
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  /**
   * Resolve a `provider/name` model string against env-only secrets. Throws `ModelConfigError` on
   * absent/malformed/unsupported/missing-key — never returns a partially-configured model.
   */
  resolve(model: string | null | undefined): ResolvedModel {
    if (!model) {
      throw new ModelConfigError('no_model', 'no model configured (model is required: provider/name)');
    }
    const slash = model.indexOf('/');
    if (slash <= 0 || slash === model.length - 1) {
      throw new ModelConfigError('malformed', `model must be "provider/name" (got "${model}")`);
    }
    const providerRaw = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    if (!(SUPPORTED as readonly string[]).includes(providerRaw)) {
      throw new ModelConfigError(
        'unsupported_provider',
        `unsupported model provider "${providerRaw}" (supported: ${SUPPORTED.join(', ')})`,
      );
    }
    const provider = providerRaw as ModelProvider;

    const baseURL = this.providerBaseUrl(provider);
    const keyEnv = PROVIDER_KEY_ENV[provider];
    let apiKey: string | undefined;
    if (keyEnv !== null) {
      const key = this.env[keyEnv];
      if (!key) {
        throw new ModelConfigError('missing_key', `${keyEnv} is not set (required for provider "${provider}")`);
      }
      apiKey = key;
    } else if (!baseURL) {
      // Keyless provider still needs an endpoint to reach.
      throw new ModelConfigError('missing_key', `OLLAMA_BASE_URL is not set (required for provider "${provider}")`);
    }

    return { provider, modelId, modelString: model, apiKey, baseURL };
  }

  /** Validate-only (require-explicit) — used by the orchestrator before launching anything. */
  validate(model: string | null | undefined): void {
    this.resolve(model);
  }

  /**
   * One structured-extraction model call (the surfaced replay fallback, ARCHITECTURE §6.3). Resolves
   * `model` (`provider/name`, require-explicit) and runs the AI SDK's `generateObject` against the
   * given Zod schema. This is the ONLY model call on the replay path, and it lives here so the
   * deterministic runner never imports a provider SDK.
   */
  async extractObject<T>(input: { model: string | null; schema: z.ZodType<T>; prompt: string }): Promise<T> {
    const resolved = this.resolve(input.model);
    const { object } = await generateObject({
      model: this.buildModel(resolved),
      schema: input.schema,
      prompt: input.prompt,
    });
    return object;
  }

  /** Build the AI-SDK language model for a resolved provider. Anthropic wired this phase. */
  private buildModel(resolved: ResolvedModel): ReturnType<ReturnType<typeof createAnthropic>> {
    if (resolved.provider === 'anthropic') {
      return createAnthropic({ apiKey: resolved.apiKey, baseURL: resolved.baseURL })(resolved.modelId);
    }
    throw new ModelConfigError(
      'unsupported_provider',
      `LLM fallback is only wired for "anthropic" this phase (got "${resolved.provider}")`,
    );
  }

  private providerBaseUrl(provider: ModelProvider): string | undefined {
    if (provider === 'ollama') return this.env.OLLAMA_BASE_URL || undefined;
    if (provider === 'openai') return this.env.OPENAI_BASE_URL || undefined;
    // `@ai-sdk/anthropic` (what Stagehand calls) appends `/messages`, so it needs a base URL ending in
    // `/v1`. But the conventional `ANTHROPIC_BASE_URL` is the ROOT (the Anthropic SDK appends `/v1`
    // itself), so a root value 404s at `/messages`. Normalize: ensure a version suffix is present.
    if (provider === 'anthropic') {
      const root = (this.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
      return /\/v\d+$/.test(root) ? root : `${root}/v1`;
    }
    return undefined;
  }
}
