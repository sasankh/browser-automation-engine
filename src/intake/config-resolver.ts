import type { PayloadConfig } from './payload-schema';
import type { Logger } from '../shared/logger';

/**
 * Resolved per-run behavior config — exactly the keys echoed in `meta.effective_config`
 * (DECISIONS #13). Resolution per key: payload.config > env > built-in default (PROJECT_SPEC §10).
 * `model` has NO built-in default (require-explicit, DECISIONS #11); enforcement is Phase 4.
 */
export interface BehaviorConfig {
  playbook_self_heal: boolean;
  self_heal_on_extraction_failure: boolean;
  run_timeout_seconds: number;
  agent_max_steps: number;
  model: string | null;
  evidence_capture: boolean;
  evidence_inline: boolean;
  proxy_enabled: boolean;
  headless: boolean;
  allow_offsite: boolean;
  replay_llm_fallback: 'on' | 'off';
  replay_llm_fallback_model: string | null;
  force_relearn: boolean;
}

/** Env-only keys a payload must never set; an attempt is ignored and logged at debug. */
const ENV_ONLY_KEYS: ReadonlySet<string> = new Set([
  'MAX_CONCURRENT_RUNS',
  'MAX_QUEUE_DEPTH',
  'BROWSER_RECYCLE_RUNS',
  'MAX_RUN_TIMEOUT_SECONDS',
  'DATABASE_URL',
  'STORAGE_BACKEND',
  'STORAGE_LOCAL_PATH',
  'SERVICE_MODE',
  'API_AUTH_MODE',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OLLAMA_BASE_URL',
]);

function boolEnv(envVal: string | undefined, def: boolean): boolean {
  if (envVal === undefined || envVal === '') return def;
  return envVal === 'true' || envVal === '1';
}

function intEnv(envVal: string | undefined, def: number): number {
  if (envVal === undefined || envVal === '') return def;
  const n = Number(envVal);
  return Number.isInteger(n) && n > 0 ? n : def;
}

export interface ResolveOptions {
  maxRunTimeoutSeconds: number;
}

export function resolveBehaviorConfig(
  config: PayloadConfig,
  env: NodeJS.ProcessEnv,
  opts: ResolveOptions,
  log?: Logger,
): BehaviorConfig {
  const c = config ?? {};

  for (const key of Object.keys(c)) {
    if (ENV_ONLY_KEYS.has(key)) {
      log?.debug({ key }, 'ignoring payload attempt to set env-only config key');
    }
  }

  const runTimeout = c.run_timeout_seconds ?? intEnv(env.RUN_TIMEOUT_SECONDS, 180);

  return Object.freeze({
    playbook_self_heal: c.playbook_self_heal ?? boolEnv(env.CONFIG_PLAYBOOK_SELF_HEAL, true),
    self_heal_on_extraction_failure:
      c.self_heal_on_extraction_failure ?? boolEnv(env.CONFIG_SELF_HEAL_ON_EXTRACTION_FAILURE, false),
    // A payload may shorten its own run; a hard ceiling caps it (PROJECT_SPEC §10).
    run_timeout_seconds: Math.min(runTimeout, opts.maxRunTimeoutSeconds),
    agent_max_steps: c.agent_max_steps ?? intEnv(env.CONFIG_AGENT_MAX_STEPS, 25),
    model: c.model ?? (env.CONFIG_MODEL && env.CONFIG_MODEL !== '' ? env.CONFIG_MODEL : null),
    evidence_capture: c.evidence_capture ?? boolEnv(env.CONFIG_EVIDENCE_CAPTURE, true),
    evidence_inline: c.evidence_inline ?? boolEnv(env.CONFIG_EVIDENCE_INLINE, false),
    proxy_enabled: c.proxy_enabled ?? boolEnv(env.CONFIG_PROXY_ENABLED, false),
    headless: c.headless ?? boolEnv(env.CONFIG_HEADLESS, true),
    allow_offsite: c.allow_offsite ?? boolEnv(env.CONFIG_ALLOW_OFFSITE, false),
    replay_llm_fallback:
      c.replay_llm_fallback ?? (env.REPLAY_LLM_FALLBACK === 'on' ? 'on' : 'off'),
    replay_llm_fallback_model:
      c.replay_llm_fallback_model ??
      (env.REPLAY_LLM_FALLBACK_MODEL && env.REPLAY_LLM_FALLBACK_MODEL !== ''
        ? env.REPLAY_LLM_FALLBACK_MODEL
        : null),
    // Payload-only; no env source.
    force_relearn: c.force_relearn ?? false,
  });
}

/** The envelope's `meta.effective_config` is exactly the resolved behavior config (DECISIONS #13). */
export function toEffectiveConfig(resolved: BehaviorConfig): Record<string, unknown> {
  return { ...resolved };
}
