import type { EnvConfig } from '../shared/env';
import type { RunStore } from '../persistence/runs/run-store.pg';
import type { IdempotencyGuard } from '../intake/idempotency';
import type { PlaybookRepository } from '../persistence/playbooks/repository';
import type { PlaybookRunner } from '../execution/playbook/runner';
import { resolveBehaviorConfig, toEffectiveConfig } from '../intake/config-resolver';
import type { BehaviorConfig } from '../intake/config-resolver';
import { newRunId } from '../shared/ids';
import type { Payload } from '../intake/payload-schema';
import type { Envelope } from '../types/envelope';
import type { RunData } from '../execution/playbook/step-interpreter';
import type { PlaybookVersion } from '../execution/playbook/playbook-schema';
import { runLogger } from '../shared/logger';

/** With API_AUTH_MODE=none there is no caller identity — idempotency is global by key. */
const DEFAULT_CALLER = 'default';
/** Default per-step Playwright timeout (a step's own `timeout_ms` overrides it). */
const DEFAULT_STEP_TIMEOUT_MS = 15_000;

export type SubmitResult =
  | { kind: 'accepted'; run_id: string }
  | { kind: 'rejected'; http: number; code: string; message: string };

export interface OrchestratorDeps {
  env: EnvConfig;
  nodeEnv: NodeJS.ProcessEnv;
  runs: RunStore;
  idempotency: IdempotencyGuard;
  playbooks: PlaybookRepository;
  runner: PlaybookRunner;
}

/**
 * The one transport-agnostic entry point (resolution logic, PROJECT_SPEC §5.3). Phase 2 resolves the
 * `playbook_id` path to the deterministic runner; the `instruction` path stays stubbed until Phase 4.
 * Replay validation (playbook exists, required keys present) is synchronous — it fails fast with
 * 404/422 BEFORE a run row or a browser is created.
 */
export class RunOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async submit(payload: Payload): Promise<SubmitResult> {
    if (payload.idempotency_key) {
      const existing = await this.deps.idempotency.lookup(DEFAULT_CALLER, payload.idempotency_key);
      if (existing) return { kind: 'accepted', run_id: existing };
    }
    const behavior = resolveBehaviorConfig(payload.config, this.deps.nodeEnv, {
      maxRunTimeoutSeconds: this.deps.env.maxRunTimeoutSeconds,
    });
    return payload.playbook_id
      ? this.submitPlaybook(payload, behavior)
      : this.submitAgentStub(payload, behavior);
  }

  private async submitPlaybook(payload: Payload, behavior: BehaviorConfig): Promise<SubmitResult> {
    const playbookId = payload.playbook_id;
    if (!playbookId) return { kind: 'rejected', http: 500, code: 'internal_error', message: 'no playbook_id' };

    const resolved = await this.deps.playbooks.resolveForReplay(playbookId, payload.playbook_version);
    if (!resolved) {
      return { kind: 'rejected', http: 404, code: 'playbook_not_found', message: `playbook not found: ${playbookId}` };
    }

    const data = (payload.data ?? {}) as RunData;
    const missing = resolved.required_data_keys.filter((k) => !(k in data));
    if (missing.length > 0) {
      return {
        kind: 'rejected',
        http: 422,
        code: 'validation_error',
        message: `missing required data keys: ${missing.join(', ')}`,
      };
    }

    const body = await this.deps.playbooks.loadVersion(playbookId, resolved.version);
    if (!body) {
      return {
        kind: 'rejected',
        http: 404,
        code: 'playbook_not_found',
        message: `playbook version body missing: ${playbookId} v${resolved.version}`,
      };
    }

    const runId = newRunId();
    await this.deps.runs.createRun({
      id: runId,
      effectiveConfig: toEffectiveConfig(behavior),
      dataKeys: Object.keys(data),
      callbackUrl: payload.callback_url ?? null,
      mode: 'playbook',
      playbookId,
      playbookVersion: resolved.version,
    });

    const finalRunId = await this.claimIdempotency(payload, runId);
    if (finalRunId !== runId) return { kind: 'accepted', run_id: finalRunId };

    void this.executePlaybook(runId, body, data, behavior);
    return { kind: 'accepted', run_id: runId };
  }

  private async submitAgentStub(payload: Payload, behavior: BehaviorConfig): Promise<SubmitResult> {
    const data = (payload.data ?? {}) as RunData;
    const runId = newRunId();
    await this.deps.runs.createRun({
      id: runId,
      effectiveConfig: toEffectiveConfig(behavior),
      dataKeys: Object.keys(data),
      callbackUrl: payload.callback_url ?? null,
    });
    const finalRunId = await this.claimIdempotency(payload, runId);
    if (finalRunId !== runId) return { kind: 'accepted', run_id: finalRunId };
    void this.runStub(runId);
    return { kind: 'accepted', run_id: runId };
  }

  /** Returns the winning run_id (ours, or an existing one on idempotency conflict — deleting our orphan). */
  private async claimIdempotency(payload: Payload, runId: string): Promise<string> {
    if (!payload.idempotency_key) return runId;
    const winner = await this.deps.idempotency.record(DEFAULT_CALLER, payload.idempotency_key, runId);
    if (winner !== runId) await this.deps.runs.deleteRun(runId);
    return winner;
  }

  async getEnvelope(runId: string): Promise<Envelope | null> {
    return this.deps.runs.getEnvelope(runId);
  }

  private async executePlaybook(
    runId: string,
    body: PlaybookVersion,
    data: RunData,
    behavior: BehaviorConfig,
  ): Promise<void> {
    try {
      await this.deps.runs.markRunning(runId);
      const outcome = await this.deps.runner.run({
        runId,
        playbook: body,
        data,
        headless: behavior.headless,
        defaultTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
        captureEvidence: behavior.evidence_capture,
      });
      await this.deps.runs.finishRun(runId, {
        status: outcome.status,
        result: outcome.result,
        error: outcome.error,
        extractionErrors: outcome.extractionErrors,
        evidenceCaptured: outcome.evidenceCaptured,
      });
    } catch (err) {
      runLogger(runId).error({ err }, 'playbook run crashed');
      await this.deps.runs
        .finishRun(runId, {
          status: 'failed',
          error: { code: 'internal_error', message: `run crashed: ${String(err)}` },
        })
        .catch(() => undefined);
    }
  }

  /** Agent path is Phase 4 — still stubbed (DECISIONS #12). */
  private async runStub(runId: string): Promise<void> {
    try {
      await this.deps.runs.markRunning(runId);
      await this.deps.runs.finishRun(runId, {
        status: 'failed',
        error: { code: 'internal_error', message: 'execution not implemented (agent path is Phase 4)' },
      });
    } catch (err) {
      runLogger(runId).error({ err }, 'stub run failed');
    }
  }
}
