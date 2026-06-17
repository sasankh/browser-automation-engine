import type { EnvConfig } from '../shared/env';
import type { RunStore } from '../persistence/runs/run-store.pg';
import type { IdempotencyGuard } from '../intake/idempotency';
import type { PlaybookRepository } from '../persistence/playbooks/repository';
import type { PlaybookRunner } from '../execution/playbook/runner';
import type { Lifecycle } from './lifecycle';
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
const RETRY_AFTER_SECONDS = 1;

export type SubmitResult =
  | { kind: 'accepted'; run_id: string }
  | { kind: 'rejected'; http: number; code?: string; message: string; retryAfterSeconds?: number };

export interface OrchestratorDeps {
  env: EnvConfig;
  nodeEnv: NodeJS.ProcessEnv;
  runs: RunStore;
  idempotency: IdempotencyGuard;
  playbooks: PlaybookRepository;
  runner: PlaybookRunner;
  lifecycle: Lifecycle;
}

/**
 * The one transport-agnostic entry point (resolution logic, PROJECT_SPEC §5.3). A synchronous
 * capacity reservation is taken FIRST so backpressure is deterministic; it is consumed by the
 * playbook execution path (released when the run settles) and released by `finally` on every other
 * path. The `instruction` path stays stubbed until Phase 4.
 */
export class RunOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async submit(payload: Payload): Promise<SubmitResult> {
    if (this.deps.lifecycle.isDraining) {
      return { kind: 'rejected', http: 503, message: 'engine is draining for shutdown' };
    }
    // Synchronous capacity gate FIRST (before any await) — deterministic 429 backpressure.
    if (!this.deps.lifecycle.tryReserve()) {
      return {
        kind: 'rejected',
        http: 429,
        message: 'too many concurrent runs; retry later',
        retryAfterSeconds: RETRY_AFTER_SECONDS,
      };
    }

    let consumed = false;
    try {
      if (payload.idempotency_key) {
        const existing = await this.deps.idempotency.lookup(DEFAULT_CALLER, payload.idempotency_key);
        if (existing) return { kind: 'accepted', run_id: existing };
      }

      const behavior = resolveBehaviorConfig(payload.config, this.deps.nodeEnv, {
        maxRunTimeoutSeconds: this.deps.env.maxRunTimeoutSeconds,
      });

      if (payload.playbook_id) {
        const resolved = await this.deps.playbooks.resolveForReplay(payload.playbook_id, payload.playbook_version);
        if (!resolved) {
          return { kind: 'rejected', http: 404, code: 'playbook_not_found', message: `playbook not found: ${payload.playbook_id}` };
        }
        const data = (payload.data ?? {}) as RunData;
        const missing = resolved.required_data_keys.filter((k) => !(k in data));
        if (missing.length > 0) {
          return { kind: 'rejected', http: 422, code: 'validation_error', message: `missing required data keys: ${missing.join(', ')}` };
        }
        const body = await this.deps.playbooks.loadVersion(payload.playbook_id, resolved.version);
        if (!body) {
          return { kind: 'rejected', http: 404, code: 'playbook_not_found', message: `playbook version body missing: ${payload.playbook_id} v${resolved.version}` };
        }

        const runId = newRunId();
        await this.deps.runs.createRun({
          id: runId,
          effectiveConfig: toEffectiveConfig(behavior),
          dataKeys: Object.keys(data),
          callbackUrl: payload.callback_url ?? null,
          mode: 'playbook',
          playbookId: payload.playbook_id,
          playbookVersion: resolved.version,
        });
        const finalRunId = await this.claimIdempotency(payload, runId);
        if (finalRunId !== runId) return { kind: 'accepted', run_id: finalRunId };

        consumed = true; // executePlaybook now owns the reservation (released when the run settles)
        void this.executePlaybook(runId, body, data, behavior);
        return { kind: 'accepted', run_id: runId };
      }

      // instruction → agent stub (Phase 4); does not consume a browser slot.
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
    } finally {
      if (!consumed) this.deps.lifecycle.releaseReservation();
    }
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
      const outcome = await this.deps.lifecycle.execute(
        behavior.headless,
        behavior.run_timeout_seconds * 1000,
        async (page) => {
          await this.deps.runs.markRunning(runId); // running only once a slot is actually held
          return this.deps.runner.run({
            runId,
            page,
            playbook: body,
            data,
            defaultTimeoutMs: DEFAULT_STEP_TIMEOUT_MS,
            captureEvidence: behavior.evidence_capture,
          });
        },
      );

      if (outcome.kind === 'timeout') {
        await this.deps.runs.finishRun(runId, {
          status: 'failed',
          error: { code: 'timeout', message: `run exceeded ${behavior.run_timeout_seconds}s wall clock` },
        });
      } else {
        const o = outcome.value;
        await this.deps.runs.finishRun(runId, {
          status: o.status,
          result: o.result,
          error: o.error,
          extractionErrors: o.extractionErrors,
          evidenceCaptured: o.evidenceCaptured,
        });
      }
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
