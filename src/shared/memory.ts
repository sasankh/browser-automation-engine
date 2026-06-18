import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { logger } from './logger';

/** ~2 GB per concurrent run (ARCHITECTURE §8.2 resource guidance). */
const PER_RUN_BYTES = 2 * 1024 ** 3;

/** Warn at startup if `MAX_CONCURRENT_RUNS × ~2GB` exceeds detectable container/host memory. */
export function checkMemoryBudget(maxConcurrentRuns: number): void {
  const available = detectMemoryLimit();
  const needed = maxConcurrentRuns * PER_RUN_BYTES;
  if (available > 0 && needed > available) {
    logger.warn(
      { max_concurrent_runs: maxConcurrentRuns, needed_gb: toGb(needed), available_gb: toGb(available) },
      'MAX_CONCURRENT_RUNS may exceed available memory (~2GB/run) — risk of OOM under load',
    );
  }
}

function detectMemoryLimit(): number {
  // Prefer the cgroup limit (container), falling back to host total memory.
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (raw && raw !== 'max') {
        const n = Number(raw);
        // cgroup v1 reports a huge sentinel when unlimited; ignore implausibly large values.
        if (Number.isFinite(n) && n > 0 && n < 1024 ** 4 * 64) return n;
      }
    } catch {
      // not present on this platform; try the next source
    }
  }
  return totalmem();
}

function toGb(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}
