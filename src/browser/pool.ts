import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

export interface PooledContext {
  page: Page;
  context: BrowserContext;
  /** Close this run's context (never the shared process). Idempotent. */
  release: () => Promise<void>;
}

interface Slot {
  browser: Browser;
  runsServed: number;
  active: number;
  generation: number;
}

/**
 * Shares a Chromium **process** across runs (cheap startup) but gives every run its OWN
 * `BrowserContext` + `Page` — contexts are never reused (the isolation invariant, ARCHITECTURE §8.1).
 * A process is recycled after `recycleAfter` runs once its contexts have drained (memory hygiene);
 * `generation` increments on each fresh launch — a recycle-observable proxy, since Playwright doesn't
 * expose the OS pid. Browsers are keyed by headless mode.
 */
export class BrowserPool {
  private readonly slots = new Map<boolean, Slot>();
  private launches = 0;

  constructor(private readonly recycleAfter: number) {}

  private async slotFor(headless: boolean): Promise<Slot> {
    let slot = this.slots.get(headless);
    // Recycle a process that has served its quota — but only when no contexts are active on it.
    if (slot && slot.runsServed >= this.recycleAfter && slot.active === 0) {
      await slot.browser.close().catch(() => undefined);
      slot = undefined;
    }
    if (!slot || !slot.browser.isConnected()) {
      this.launches += 1;
      const browser = await chromium.launch({ headless, args: ['--no-sandbox'] });
      slot = { browser, runsServed: 0, active: 0, generation: this.launches };
      this.slots.set(headless, slot);
    }
    return slot;
  }

  async acquire(headless: boolean): Promise<PooledContext> {
    const slot = await this.slotFor(headless);
    slot.runsServed += 1;
    slot.active += 1;
    const context = await slot.browser.newContext();
    const page = await context.newPage();
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      slot.active -= 1;
      await context.close().catch(() => undefined);
    };
    return { page, context, release };
  }

  /** Recycle-observable proxy for the OS pid; bumps each time a fresh process is launched. */
  generation(headless: boolean): number {
    return this.slots.get(headless)?.generation ?? 0;
  }

  async shutdown(): Promise<void> {
    for (const slot of this.slots.values()) {
      await slot.browser.close().catch(() => undefined);
    }
    this.slots.clear();
  }
}
