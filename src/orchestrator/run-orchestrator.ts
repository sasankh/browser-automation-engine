import type { EnvConfig } from '../shared/env';
import type { RunStore } from '../persistence/runs/run-store.pg';
import type { IdempotencyGuard } from '../intake/idempotency';
import { resolveBehaviorConfig, toEffectiveConfig } from '../intake/config-resolver';
import { newRunId } from '../shared/ids';
import type { Payload } from '../intake/payload-schema';
import type { Envelope } from '../types/envelope';
import { runLogger } from '../shared/logger';

/** With API_AUTH_MODE=none there is no caller identity — idempotency is global by key (DECISIONS-noted). */
const DEFAULT_CALLER = 'default';

export interface OrchestratorDeps {
  env: EnvConfig;
  nodeEnv: NodeJS.ProcessEnv;
  runs: RunStore;
  idempotency: IdempotencyGuard;
}

/**
 * The one transport-agnostic entry point. Phase 1 has NO execution engine — it persists the run
 * and drives a stub that marks it `failed` / `internal_error` (DECISIONS #12). Real resolution
 * (playbook vs agent) arrives in later phases behind this same surface.
 */
export class RunOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async submit(payload: Payload): Promise<{ run_id: string; status: 'queued' }> {
    const { idempotency, runs, env, nodeEnv } = this.deps;

    if (payload.idempotency_key) {
      const existing = await idempotency.lookup(DEFAULT_CALLER, payload.idempotency_key);
      if (existing) return { run_id: existing, status: 'queued' };
    }

    const behavior = resolveBehaviorConfig(payload.config, nodeEnv, {
      maxRunTimeoutSeconds: env.maxRunTimeoutSeconds,
    });
    const runId = newRunId();
    await runs.createRun({
      id: runId,
      effectiveConfig: toEffectiveConfig(behavior),
      dataKeys: payload.data ? Object.keys(payload.data) : [],
      callbackUrl: payload.callback_url ?? null,
    });

    let finalRunId = runId;
    if (payload.idempotency_key) {
      finalRunId = await idempotency.record(DEFAULT_CALLER, payload.idempotency_key, runId);
      if (finalRunId !== runId) await runs.deleteRun(runId);
    }

    if (finalRunId === runId) void this.runStub(runId);
    return { run_id: finalRunId, status: 'queued' };
  }

  async getEnvelope(runId: string): Promise<Envelope | null> {
    return this.deps.runs.getEnvelope(runId);
  }

  /** Phase 1 stub: no execution engine yet. */
  private async runStub(runId: string): Promise<void> {
    const { runs } = this.deps;
    try {
      await runs.markRunning(runId);
      await runs.markFailed(runId, {
        code: 'internal_error',
        message: 'execution not implemented (Phase 1 skeleton)',
      });
    } catch (err) {
      runLogger(runId).error({ err }, 'stub run failed');
    }
  }
}
