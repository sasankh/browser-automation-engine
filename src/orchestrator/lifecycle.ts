import PQueue from 'p-queue';
import type { Page } from 'playwright';
import type { BrowserPool } from '../browser/pool';

export interface Saturation {
  runs_in_progress: number;
  queue_depth: number;
  max_concurrent_runs: number;
}

export type ExecOutcome<T> = { kind: 'done'; value: T } | { kind: 'timeout' };

/**
 * Bounds concurrency and protects against wedged runs (ARCHITECTURE §8.2). A `p-queue` of size
 * `MAX_CONCURRENT_RUNS` is the semaphore; a synchronous in-flight counter gates the
 * `MAX_QUEUE_DEPTH` waiting room — reserve at intake (before any await) so backpressure is
 * deterministic (→ 429). Each run gets a fresh context from the pool and a hard wall clock: on
 * timeout the context is torn down (aborting the page) and the slot is freed.
 */
export class Lifecycle {
  private readonly queue: PQueue;
  private inFlight = 0;
  private draining = false;

  constructor(
    private readonly pool: BrowserPool,
    private readonly maxConcurrentRuns: number,
    private readonly maxQueueDepth: number,
  ) {
    this.queue = new PQueue({ concurrency: Math.max(1, maxConcurrentRuns) });
  }

  /**
   * Synchronously reserve one in-flight slot (running + waiting). Returns false when draining or
   * capacity (`MAX_CONCURRENT_RUNS + MAX_QUEUE_DEPTH`) is full → caller returns 429. Must be the
   * first thing intake does, before any await, so admission order is deterministic.
   */
  tryReserve(): boolean {
    if (this.draining) return false;
    if (this.inFlight >= this.maxConcurrentRuns + this.maxQueueDepth) return false;
    this.inFlight += 1;
    return true;
  }

  /** Release a reservation that won't run (validation failed, idempotent repeat, agent stub). */
  releaseReservation(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  saturation(): Saturation {
    return {
      runs_in_progress: this.queue.pending,
      queue_depth: Math.max(0, this.inFlight - this.queue.pending),
      max_concurrent_runs: this.maxConcurrentRuns,
    };
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * Run gated work on a fresh context under the wall clock. Consumes one reservation made by
   * tryReserve() (released when the run settles). On timeout the context is closed and the page's
   * in-flight ops abort; the outcome is reported as `timeout`.
   */
  async execute<T>(
    headless: boolean,
    timeoutMs: number,
    work: (page: Page) => Promise<T>,
  ): Promise<ExecOutcome<T>> {
    try {
      const settled = (await this.queue.add(async (): Promise<ExecOutcome<T>> => {
        const ctx = await this.pool.acquire(headless);
        let timer: NodeJS.Timeout | undefined;
        try {
          const workP = work(ctx.page).then((value): ExecOutcome<T> => ({ kind: 'done', value }));
          // The losing promise keeps running until the closed context makes it throw — swallow it.
          workP.catch(() => undefined);
          const timeoutP = new Promise<ExecOutcome<T>>((resolve) => {
            timer = setTimeout(() => {
              void ctx.release();
              resolve({ kind: 'timeout' });
            }, timeoutMs);
          });
          return await Promise.race([workP, timeoutP]);
        } finally {
          if (timer) clearTimeout(timer);
          await ctx.release();
        }
      })) as ExecOutcome<T> | undefined;
      return settled ?? { kind: 'timeout' };
    } finally {
      this.releaseReservation();
    }
  }

  /**
   * Gate agent work — which manages its OWN browser (Stagehand v3.5, DECISIONS #21) — through the
   * same semaphore + wall clock as pool runs, but WITHOUT acquiring a pool context. On timeout the
   * AbortSignal fires so the agent cancels its execution and tears its browser down.
   */
  async executeAgent<T>(
    timeoutMs: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<ExecOutcome<T>> {
    try {
      const settled = (await this.queue.add(async (): Promise<ExecOutcome<T>> => {
        const ac = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        try {
          const workP = work(ac.signal).then((value): ExecOutcome<T> => ({ kind: 'done', value }));
          workP.catch(() => undefined);
          const timeoutP = new Promise<ExecOutcome<T>>((resolve) => {
            timer = setTimeout(() => {
              ac.abort();
              resolve({ kind: 'timeout' });
            }, timeoutMs);
          });
          return await Promise.race([workP, timeoutP]);
        } finally {
          if (timer) clearTimeout(timer);
          ac.abort(); // ensure the agent tears down if it is somehow still running
        }
      })) as ExecOutcome<T> | undefined;
      return settled ?? { kind: 'timeout' };
    } finally {
      this.releaseReservation();
    }
  }

  /** Stop admitting new work and wait for in-flight runs to settle, up to the grace window. */
  async drain(graceMs: number): Promise<void> {
    this.draining = true;
    await Promise.race([
      this.queue.onIdle(),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
  }
}
