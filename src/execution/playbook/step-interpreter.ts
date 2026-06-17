import type { Page, Locator } from 'playwright';
import type { Step, Assertion } from './playbook-schema';

export type StepErrorCode = 'step_failed' | 'navigation_failed' | 'timeout';

/** A step (or assertion) failure, carrying the 0-based step index for `meta.error.step`. */
export class StepError extends Error {
  constructor(
    readonly stepIndex: number,
    readonly code: StepErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

export type RunData = Record<string, string | number | boolean>;

const TEMPLATE = /\{\{\s*data\.([\w.-]+)\s*\}\}/g;

/** Bind `{{data.key}}` against THIS run's data only (no page-text scanning). */
export function bindTemplate(value: string, data: RunData): string {
  return value.replace(TEMPLATE, (_match, key: string) => {
    const v = data[key];
    return v === undefined ? '' : String(v);
  });
}

function selectorsOf(step: Step): string[] {
  const list: string[] = [];
  if (step.selector) list.push(step.selector);
  if (step.fallback_selectors) list.push(...step.fallback_selectors);
  return list;
}

/** Try the primary selector, then each fallback, until one succeeds. Throws if all fail. */
async function actOnSelector(
  page: Page,
  selectors: string[],
  timeoutMs: number,
  action: (loc: Locator) => Promise<void>,
): Promise<void> {
  if (selectors.length === 0) throw new Error('step requires a selector');
  let lastErr: unknown;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: timeoutMs });
      await action(loc);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('no selector matched');
}

export interface StepContext {
  page: Page;
  data: RunData;
  defaultTimeoutMs: number;
}

/**
 * Execute one step. `extract` is a no-op here — the runner handles it (it needs `output_format` +
 * the structural extractor). On failure: `goto` → `navigation_failed`, everything else → `step_failed`.
 */
export async function executeStep(step: Step, index: number, ctx: StepContext): Promise<void> {
  const { page, data, defaultTimeoutMs } = ctx;
  const t = step.timeout_ms ?? defaultTimeoutMs;
  try {
    switch (step.op) {
      case 'goto': {
        if (!step.url) throw new Error('goto requires url');
        try {
          await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: t });
        } catch (err) {
          throw new StepError(index, 'navigation_failed', `goto ${step.url} failed: ${String(err)}`);
        }
        return;
      }
      case 'click':
        await actOnSelector(page, selectorsOf(step), t, (loc) => loc.click({ timeout: t }));
        return;
      case 'fill': {
        if (step.value === undefined) throw new Error('fill requires value');
        const value = bindTemplate(step.value, data);
        await actOnSelector(page, selectorsOf(step), t, (loc) => loc.fill(value, { timeout: t }));
        return;
      }
      case 'select': {
        if (step.value === undefined) throw new Error('select requires value');
        const value = bindTemplate(step.value, data);
        await actOnSelector(page, selectorsOf(step), t, async (loc) => {
          await loc.selectOption(value, { timeout: t });
        });
        return;
      }
      case 'check':
        await actOnSelector(page, selectorsOf(step), t, (loc) => loc.check({ timeout: t }));
        return;
      case 'press': {
        const key = step.key;
        if (!key) throw new Error('press requires key');
        if (step.selector) {
          await actOnSelector(page, selectorsOf(step), t, (loc) => loc.press(key, { timeout: t }));
        } else {
          await page.keyboard.press(key);
        }
        return;
      }
      case 'wait_for':
        await actOnSelector(page, selectorsOf(step), t, async () => {
          /* visibility is the wait */
        });
        return;
      case 'wait_ms':
        await page.waitForTimeout(step.ms ?? 0);
        return;
      case 'scroll': {
        if (step.selector) {
          await actOnSelector(page, selectorsOf(step), t, (loc) => loc.scrollIntoViewIfNeeded({ timeout: t }));
        } else {
          await page.mouse.wheel(0, 1000);
        }
        return;
      }
      case 'screenshot':
        // Evidence is captured at run end by the runner; an inline labeled screenshot is a no-op here.
        return;
      case 'extract':
        // Handled by the runner.
        return;
    }
  } catch (err) {
    if (err instanceof StepError) throw err;
    throw new StepError(index, 'step_failed', `${step.op} failed: ${String(err)}`);
  }
}

/** Evaluate an assertion after its step; throw StepError on failure. */
export async function evaluateAssertion(
  assertion: Assertion,
  afterIndex: number,
  page: Page,
  timeoutMs: number,
): Promise<void> {
  switch (assertion.expect) {
    case 'url_matches': {
      const ok = assertion.pattern ? new RegExp(assertion.pattern).test(page.url()) : false;
      if (!ok) {
        throw new StepError(
          afterIndex,
          'step_failed',
          `assertion url_matches '${assertion.pattern}' failed (url=${page.url()})`,
        );
      }
      return;
    }
    case 'selector_present': {
      if (!assertion.selector) throw new StepError(afterIndex, 'step_failed', 'selector_present requires selector');
      try {
        await page.locator(assertion.selector).first().waitFor({ state: 'attached', timeout: timeoutMs });
      } catch {
        throw new StepError(afterIndex, 'step_failed', `assertion selector_present '${assertion.selector}' failed`);
      }
      return;
    }
    case 'selector_absent': {
      if (!assertion.selector) throw new StepError(afterIndex, 'step_failed', 'selector_absent requires selector');
      const count = await page.locator(assertion.selector).count();
      if (count > 0) {
        throw new StepError(afterIndex, 'step_failed', `assertion selector_absent '${assertion.selector}' failed (found ${count})`);
      }
      return;
    }
  }
}
