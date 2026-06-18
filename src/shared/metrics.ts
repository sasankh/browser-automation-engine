import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import type { Lifecycle } from '../orchestrator/lifecycle';

/**
 * Prometheus metrics (ARCHITECTURE §11, PROJECT_SPEC §14) on a dedicated registry, exposed at
 * `/metrics`. Enough to chart heal rate, fallback rate, saturation, and token spend from the endpoint
 * as shipped. Helpers below are the only write surface, so call sites stay terse.
 */
export const register = new Registry();
collectDefaultMetrics({ register }); // process/event-loop/gc metrics

const runsTotal = new Counter({ name: 'runs_total', help: 'Runs by mode and terminal status', labelNames: ['mode', 'status'], registers: [register] });
const healTotal = new Counter({ name: 'heal_total', help: 'Self-heal attempts by outcome', labelNames: ['outcome'], registers: [register] });
const fallbackEngagedTotal = new Counter({ name: 'fallback_engaged_total', help: 'Surfaced LLM fallback engagements', labelNames: ['playbook_id'], registers: [register] });
const agentTokensTotal = new Counter({ name: 'agent_tokens_total', help: 'Agent model tokens', labelNames: ['kind'], registers: [register] });
const runDurationSeconds = new Histogram({ name: 'run_duration_seconds', help: 'Run wall-clock by mode', labelNames: ['mode'], buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300], registers: [register] });
const webhookDeliveryTotal = new Counter({ name: 'webhook_delivery_total', help: 'Webhook deliveries by status', labelNames: ['status'], registers: [register] });
const requestsRejectedTotal = new Counter({ name: 'requests_rejected_total', help: 'Rejected intake by reason', labelNames: ['reason'], registers: [register] });
const playbookHitRatio = new Gauge({ name: 'playbook_hit_ratio', help: 'Replay (playbook) runs / total runs', registers: [register] });

let playbookRuns = 0;
let totalRuns = 0;

export function recordRunOutcome(mode: string | null, status: string, durationMs: number | null): void {
  const m = mode ?? 'unknown';
  runsTotal.inc({ mode: m, status });
  if (durationMs !== null) runDurationSeconds.observe({ mode: m }, durationMs / 1000);
  totalRuns += 1;
  if (m === 'playbook') playbookRuns += 1;
  playbookHitRatio.set(totalRuns > 0 ? playbookRuns / totalRuns : 0);
}

export function recordHeal(outcome: 'success' | 'failed'): void {
  healTotal.inc({ outcome });
}

export function recordFallback(playbookId: string): void {
  fallbackEngagedTotal.inc({ playbook_id: playbookId });
}

export function recordAgentTokens(inputTokens: number, outputTokens: number): void {
  if (inputTokens > 0) agentTokensTotal.inc({ kind: 'input' }, inputTokens);
  if (outputTokens > 0) agentTokensTotal.inc({ kind: 'output' }, outputTokens);
}

export function recordWebhook(status: string): void {
  webhookDeliveryTotal.inc({ status });
}

export function recordRejected(reason: string): void {
  requestsRejectedTotal.inc({ reason });
}

/** Live saturation gauges, read from the lifecycle on each scrape. Idempotent (safe if called twice). */
export function registerSaturationGauges(lifecycle: Lifecycle): void {
  if (register.getSingleMetric('runs_in_progress')) return;
  new Gauge({ name: 'runs_in_progress', help: 'Runs currently executing', registers: [register], collect() { this.set(lifecycle.saturation().runs_in_progress); } });
  new Gauge({ name: 'queue_depth', help: 'Runs admitted and waiting', registers: [register], collect() { this.set(lifecycle.saturation().queue_depth); } });
  new Gauge({ name: 'max_concurrent_runs', help: 'Configured concurrency ceiling', registers: [register], collect() { this.set(lifecycle.saturation().max_concurrent_runs); } });
}
