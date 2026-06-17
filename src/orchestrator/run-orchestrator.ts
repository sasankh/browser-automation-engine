import type { EnvConfig } from '../shared/env';
import type { RunStore } from '../persistence/runs/run-store.pg';
import type { IdempotencyGuard } from '../intake/idempotency';
import type { PlaybookRepository } from '../persistence/playbooks/repository';
import type { PlaybookRunner, RunOutcome } from '../execution/playbook/runner';
import type { LlmExtractFallback } from '../execution/playbook/llm-fallback';
import type { Lifecycle } from './lifecycle';
import { resolveBehaviorConfig, toEffectiveConfig } from '../intake/config-resolver';
import type { BehaviorConfig } from '../intake/config-resolver';
import { newRunId, newPlaybookId } from '../shared/ids';
import type { Payload } from '../intake/payload-schema';
import type { Envelope } from '../types/envelope';
import type { RunError } from '../types/errors';
import type { RunData } from '../execution/playbook/step-interpreter';
import type { PlaybookVersion } from '../execution/playbook/playbook-schema';
import { ModelGateway, ModelConfigError, type ResolvedModel } from '../model/model-gateway';
import { AgentError } from '../execution/agent/agent-engine';
import type { AgentRunner } from '../execution/agent/agent-engine';
import { compilePlaybook } from '../execution/agent/compiler';
import { healPolicyForError, shouldHealExtractionMiss } from './heal';
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
  modelGateway: ModelGateway;
  agentEngine: AgentRunner;
  /** Surfaced LLM extraction fallback (Phase 5) — engaged only when REPLAY_LLM_FALLBACK=on + a model. */
  fallback: LlmExtractFallback;
}

/** Inputs threaded into an agent (learn) run; `relearnPlaybookId` is set only on a force-relearn. */
interface AgentArgs {
  instruction: string;
  url: string;
  data: RunData;
  outputFormat: Record<string, unknown> | null;
  relearnPlaybookId: string | null;
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

      if (payload.playbook_id && !behavior.force_relearn) {
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
        void this.executePlaybook(runId, payload.playbook_id, resolved.version, body, data, behavior);
        return { kind: 'accepted', run_id: runId };
      }

      // Agent (learn) path: a fresh instruction+url, or a forced relearn of an existing playbook.
      const instruction = payload.instruction;
      const url = payload.url;
      if (!instruction || !url) {
        return { kind: 'rejected', http: 422, code: 'validation_error', message: 'instruction and url are required to learn a playbook' };
      }
      // Require-explicit model (DECISIONS #11): validate upfront, before any browser launches.
      try {
        this.deps.modelGateway.validate(behavior.model);
      } catch (err) {
        if (err instanceof ModelConfigError) {
          return { kind: 'rejected', http: 422, code: 'validation_error', message: err.message };
        }
        throw err;
      }

      const data = (payload.data ?? {}) as RunData;
      const runId = newRunId();
      await this.deps.runs.createRun({
        id: runId,
        effectiveConfig: toEffectiveConfig(behavior),
        dataKeys: Object.keys(data),
        callbackUrl: payload.callback_url ?? null,
        mode: 'agent',
        playbookId: payload.playbook_id ?? null,
      });
      const finalRunId = await this.claimIdempotency(payload, runId);
      if (finalRunId !== runId) return { kind: 'accepted', run_id: finalRunId };

      consumed = true; // executeAgent now owns the reservation (released when the run settles)
      void this.executeAgent(
        runId,
        { instruction, url, data, outputFormat: payload.output_format ?? null, relearnPlaybookId: payload.playbook_id ?? null },
        behavior,
      );
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
    playbookId: string,
    version: number,
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
            fallback: this.replayFallback(behavior),
          });
        },
      );

      if (outcome.kind === 'timeout') {
        // `timeout` is never-heal (§7) — surface it.
        await this.deps.runs.finishRun(runId, {
          status: 'failed',
          error: { code: 'timeout', message: `run exceeded ${behavior.run_timeout_seconds}s wall clock` },
        });
        return;
      }

      const o = outcome.value;
      if (this.wantsHeal(o, behavior)) {
        await this.healRun(runId, playbookId, data, behavior, o);
        return;
      }

      // No heal: persist the replay outcome (incl. the surfaced fallback flags).
      await this.deps.runs.finishRun(runId, {
        status: o.status,
        result: o.result,
        error: this.markHealEligibleButDisabled(o, behavior),
        extractionErrors: o.extractionErrors,
        evidenceCaptured: o.evidenceCaptured,
        playbookId,
        playbookVersion: version,
        llmFallbackUsed: o.llmFallbackUsed || null,
        fallbackFields: o.fallbackFields,
      });
      if (o.llmFallbackUsed) {
        await this.deps.playbooks.recordFallbackEngagement(playbookId, {
          driftSignal: this.deps.env.fallbackAsDriftSignal,
          threshold: this.deps.env.fallbackDriftThreshold,
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
    } finally {
      this.deps.lifecycle.releaseReservation(); // released ONCE per run (after any heal — DECISIONS #28)
    }
  }

  /** The replay fallback engine + model, or undefined when REPLAY_LLM_FALLBACK is off / no model set. */
  private replayFallback(behavior: BehaviorConfig): { engine: LlmExtractFallback; model: string } | undefined {
    if (behavior.replay_llm_fallback === 'on' && behavior.replay_llm_fallback_model) {
      return { engine: this.deps.fallback, model: behavior.replay_llm_fallback_model };
    }
    return undefined;
  }

  /** Does this replay outcome escalate to a self-heal (per §7 + config)? */
  private wantsHeal(o: RunOutcome, behavior: BehaviorConfig): boolean {
    if (!behavior.playbook_self_heal) return false;
    const opts = { selfHealOnExtractionFailure: behavior.self_heal_on_extraction_failure };
    if (o.status === 'failed' && o.error) return healPolicyForError(o.error.code, opts) === 'heal';
    // Fallback-first-then-heal (DECISIONS #26): a still-missing extraction escalates only if configured.
    if (o.status === 'completed_with_extraction_errors') return shouldHealExtractionMiss(opts);
    return false;
  }

  /** Tag a non-healed failure that WAS heal-eligible but self-heal was disabled (`heal_attempted:false`). */
  private markHealEligibleButDisabled(o: RunOutcome, behavior: BehaviorConfig): RunError | null {
    if (o.status !== 'failed' || !o.error) return o.error;
    const opts = { selfHealOnExtractionFailure: behavior.self_heal_on_extraction_failure };
    if (!behavior.playbook_self_heal && healPolicyForError(o.error.code, opts) === 'heal') {
      return { ...o.error, heal_attempted: false };
    }
    return o.error;
  }

  /**
   * Self-heal (ARCHITECTURE §6.4, PROJECT_SPEC §9.3): the SAME run continues in agent mode against the
   * stored instruction/url, compiles a healed `v(n+1)` (Postgres TXN resets the heal counter), and the
   * envelope carries `mode=agent`, `self_healed=true`, and the new version. A heal that fails bumps
   * `consecutive_heal_failures` (→ `health=unhealthy` at the threshold) and surfaces `heal_attempted`.
   */
  private async healRun(
    runId: string,
    playbookId: string,
    data: RunData,
    behavior: BehaviorConfig,
    failure: RunOutcome,
  ): Promise<void> {
    const baseError: RunError = failure.error ?? { code: 'step_failed', message: 'replay failed' };
    const contract = await this.deps.playbooks.getContract(playbookId);
    if (!contract) {
      await this.deps.runs.finishRun(runId, {
        status: 'failed',
        error: { ...baseError, heal_attempted: false, heal_outcome: 'playbook_not_found' },
      });
      return;
    }
    // Heal is an agent run → require-explicit model. None resolved → can't heal; surface cleanly.
    let model: ResolvedModel;
    try {
      model = this.deps.modelGateway.resolve(behavior.model);
    } catch {
      await this.deps.runs.finishRun(runId, {
        status: 'failed',
        error: { ...baseError, heal_attempted: false, heal_outcome: 'no_model_configured' },
      });
      return;
    }

    runLogger(runId).info({ playbook_id: playbookId, failed_with: baseError.code }, 'self-heal triggered');
    try {
      const outcome = await this.deps.lifecycle.executeAgent(
        behavior.run_timeout_seconds * 1000,
        async (signal) =>
          this.deps.agentEngine.run({
            runId,
            instruction: contract.instruction,
            url: contract.url,
            data,
            outputFormat: contract.output_format,
            config: {
              model,
              agentMaxSteps: behavior.agent_max_steps,
              headless: behavior.headless,
              allowOffsite: behavior.allow_offsite,
              proxyEnabled: behavior.proxy_enabled,
              captureEvidence: behavior.evidence_capture,
            },
            signal,
          }),
      );

      if (outcome.kind === 'timeout') {
        await this.deps.playbooks.recordHealFailure(playbookId, this.deps.env.healFailureThreshold);
        await this.deps.runs.finishRun(runId, {
          status: 'failed',
          mode: 'agent',
          selfHealed: true,
          error: { ...baseError, heal_attempted: true, heal_outcome: 'heal_timed_out' },
        });
        return;
      }

      const learn = outcome.value;
      const healedBody = compilePlaybook({
        recorded: learn.recorded,
        outputFormat: contract.output_format,
        extractionFields: learn.extractionFields,
        scopeSelector: learn.scopeSelector,
      });
      const newVersion = await this.deps.playbooks.addVersionHealed(playbookId, healedBody, runId);
      const hasErrors = learn.extractionErrors.length > 0;
      await this.deps.runs.finishRun(runId, {
        status: hasErrors ? 'completed_with_extraction_errors' : 'completed',
        result: learn.result,
        extractionErrors: hasErrors ? learn.extractionErrors : null,
        evidenceCaptured: behavior.evidence_capture,
        mode: 'agent',
        selfHealed: true,
        playbookId,
        playbookVersion: newVersion,
      });
      runLogger(runId).info(
        { playbook_id: playbookId, version: newVersion, usage: learn.usage },
        'self-heal compiled a new version',
      );
    } catch (err) {
      const healOutcome = err instanceof AgentError ? err.code : String(err);
      await this.deps.playbooks.recordHealFailure(playbookId, this.deps.env.healFailureThreshold);
      await this.deps.runs.finishRun(runId, {
        status: 'failed',
        mode: 'agent',
        selfHealed: true,
        error: { ...baseError, heal_attempted: true, heal_outcome: healOutcome },
      });
      runLogger(runId).error({ err, playbook_id: playbookId }, 'self-heal failed');
    }
  }

  /**
   * The learn path: drive the agent (its own browser, DECISIONS #21) under the wall clock, compile the
   * recorded actions into a playbook, persist it (new playbook, or a new version on a forced relearn),
   * and finish the run carrying the new playbook_id + version. Every failure classifies to a §7 code.
   */
  private async executeAgent(runId: string, args: AgentArgs, behavior: BehaviorConfig): Promise<void> {
    try {
      const model = this.deps.modelGateway.resolve(behavior.model); // already validated at intake
      const outcome = await this.deps.lifecycle.executeAgent(
        behavior.run_timeout_seconds * 1000,
        async (signal) => {
          await this.deps.runs.markRunning(runId);
          return this.deps.agentEngine.run({
            runId,
            instruction: args.instruction,
            url: args.url,
            data: args.data,
            outputFormat: args.outputFormat,
            config: {
              model,
              agentMaxSteps: behavior.agent_max_steps,
              headless: behavior.headless,
              allowOffsite: behavior.allow_offsite,
              proxyEnabled: behavior.proxy_enabled,
              captureEvidence: behavior.evidence_capture,
            },
            signal,
          });
        },
      );

      if (outcome.kind === 'timeout') {
        await this.deps.runs.finishRun(runId, {
          status: 'failed',
          error: { code: 'timeout', message: `agent run exceeded ${behavior.run_timeout_seconds}s wall clock` },
        });
        return;
      }

      const learn = outcome.value;
      const body = compilePlaybook({
        recorded: learn.recorded,
        outputFormat: args.outputFormat,
        extractionFields: learn.extractionFields,
        scopeSelector: learn.scopeSelector,
      });

      // Persist: a new playbook, or a new version on a forced relearn of an existing one.
      let playbookId: string;
      let version: number;
      if (args.relearnPlaybookId) {
        playbookId = args.relearnPlaybookId;
        version = await this.deps.playbooks.addVersion(playbookId, body, 'agent_initial', runId);
      } else {
        playbookId = newPlaybookId();
        await this.deps.playbooks.create({
          id: playbookId,
          url: args.url,
          instruction: args.instruction,
          createdBy: 'agent_initial',
          runId,
          body,
        });
        version = 1;
      }

      const hasErrors = learn.extractionErrors.length > 0;
      await this.deps.runs.finishRun(runId, {
        status: hasErrors ? 'completed_with_extraction_errors' : 'completed',
        result: learn.result,
        extractionErrors: hasErrors ? learn.extractionErrors : null,
        evidenceCaptured: behavior.evidence_capture,
        playbookId,
        playbookVersion: version,
      });
      // Economics sanity (plan §risks): the agent run's token cost vs the ~free replay.
      runLogger(runId).info(
        { playbook_id: playbookId, version, usage: learn.usage },
        'agent learn compiled to playbook',
      );
    } catch (err) {
      const error =
        err instanceof AgentError
          ? { code: err.code, message: err.message }
          : { code: 'internal_error' as const, message: `agent run crashed: ${String(err)}` };
      runLogger(runId).error({ err }, 'agent run failed');
      await this.deps.runs.finishRun(runId, { status: 'failed', error }).catch(() => undefined);
    } finally {
      this.deps.lifecycle.releaseReservation(); // released ONCE per run (DECISIONS #28)
    }
  }
}
