import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

/** A cached `observe()` result: the chosen selector plus alternates, keyed by (url, instruction). */
export interface CachedSelectors {
  selector: string;
  fallbackSelectors: string[];
  description?: string;
}

/**
 * Persists Stagehand `observe()` results so a repeat agent operation can skip a model round-trip
 * (ARCHITECTURE §3.4). Backend-agnostic interface (the S3 impl is Phase 6); a miss simply means the
 * agent re-observes. This is an optimization only — never a correctness dependency.
 */
export interface SelectorCache {
  get(url: string, instruction: string): Promise<CachedSelectors | null>;
  set(url: string, instruction: string, value: CachedSelectors): Promise<void>;
}

export function selectorCacheKey(url: string, instruction: string): string {
  return createHash('sha256').update(`${url}\n${instruction}`).digest('hex').slice(0, 32);
}

/** Local-FS implementation: one JSON file per key under `{basePath}/selector-cache/`. */
export class LocalSelectorCache implements SelectorCache {
  constructor(private readonly basePath: string) {}

  private pathFor(url: string, instruction: string): string {
    return join(this.basePath, 'selector-cache', `${selectorCacheKey(url, instruction)}.json`);
  }

  async get(url: string, instruction: string): Promise<CachedSelectors | null> {
    try {
      const raw = await readFile(this.pathFor(url, instruction), 'utf8');
      return JSON.parse(raw) as CachedSelectors;
    } catch {
      return null; // miss (or unreadable) ⇒ caller re-observes
    }
  }

  async set(url: string, instruction: string, value: CachedSelectors): Promise<void> {
    const path = this.pathFor(url, instruction);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value), 'utf8');
  }
}
