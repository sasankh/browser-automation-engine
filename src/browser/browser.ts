import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

/**
 * Minimal browser layer for Phase 2. A Chromium **process** is shared (cheap), but every run gets
 * its OWN `BrowserContext` + `Page`, closed at run end — the isolation invariant (ARCHITECTURE §8.1).
 * The semaphore / bounded queue / `RUN_TIMEOUT_SECONDS` / `BROWSER_RECYCLE_RUNS` and the formal pool
 * land in Phase 3; this is the process-sharing seam they build on. Browsers are keyed by headless mode.
 */
const browsers = new Map<boolean, Browser>();

async function getBrowser(headless: boolean): Promise<Browser> {
  let browser = browsers.get(headless);
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless, args: ['--no-sandbox'] });
    browsers.set(headless, browser);
  }
  return browser;
}

export interface RunBrowser {
  page: Page;
  context: BrowserContext;
  /** Close this run's context (never the shared process). */
  close: () => Promise<void>;
}

export async function acquireRunBrowser(headless: boolean): Promise<RunBrowser> {
  const browser = await getBrowser(headless);
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    page,
    context,
    close: async () => {
      await context.close();
    },
  };
}

/** Close all shared browser processes (graceful shutdown / test teardown). */
export async function shutdownBrowsers(): Promise<void> {
  for (const browser of browsers.values()) {
    await browser.close();
  }
  browsers.clear();
}
