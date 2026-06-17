import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import type { EvidenceStore } from '../../persistence/evidence/evidence';
import type { SelectorCache } from '../../persistence/cache/selector-cache';
import type { ErrorCode } from '../../types/errors';
import type { RunData } from '../playbook/step-interpreter';
import type { ResolvedModel } from '../../model/model-gateway';
import type { AgentLearnResult, ExtractionFields, RecordedAction } from './recorded-action';
import { assertAllowedUrl, SsrfError, isOffSite } from '../../browser/ssrf-guard';
import { runLogger } from '../../shared/logger';

/** An agent-run failure already classified to a §7 error code (never thrown raw past the engine). */
export class AgentError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/** Known CAPTCHA fingerprints — presence short-circuits the run with `captcha_detected`. */
const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '.g-recaptcha',
  '#cf-challenge-running',
  'iframe[title*="captcha" i]',
];

export interface AgentRunConfig {
  model: ResolvedModel;
  agentMaxSteps: number;
  headless: boolean;
  allowOffsite: boolean;
  proxyEnabled: boolean;
  captureEvidence: boolean;
}

export interface AgentRunInput {
  runId: string;
  instruction: string;
  url: string;
  data: RunData;
  outputFormat: Record<string, unknown> | null;
  config: AgentRunConfig;
  /** From the lifecycle wall clock; aborting cancels the agent execution. */
  signal: AbortSignal;
}

export interface AgentEngineDeps {
  evidence: EvidenceStore;
  selectorCache: SelectorCache;
  env: NodeJS.ProcessEnv;
}

/** The orchestrator depends on this narrow surface, so heal/learn tests can inject a fake (no LLM). */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentLearnResult>;
}

/**
 * The expensive path (PROJECT_SPEC §9.1): Stagehand v3.5 drives the task from a natural-language
 * instruction, we record the effective actions (with `data` provenance) for the compiler, extract the
 * result, and capture evidence. Stagehand owns its own CDP browser (DECISIONS #21) — one instance per
 * run, disposed in `finally`. This is the ONLY module that imports Stagehand.
 */
export class AgentEngine implements AgentRunner {
  constructor(private readonly deps: AgentEngineDeps) {}

  async run(input: AgentRunInput): Promise<AgentLearnResult> {
    const log = runLogger(input.runId);
    const allowPrivateHosts = this.deps.env.ALLOW_PRIVATE_TARGETS === 'true';

    // SSRF: validate the caller-supplied target before launching anything.
    let target: URL;
    try {
      target = assertAllowedUrl(input.url, { allowPrivateHosts });
    } catch (err) {
      if (err instanceof SsrfError) throw new AgentError('navigation_failed', err.message);
      throw err;
    }

    const stagehand = new Stagehand({
      env: 'LOCAL',
      // Fully local (no Browserbase API); `experimental` unlocks the agent abort signal we use for the
      // wall-clock cancellation. Both are required by Stagehand v3.5 to pass `signal` to agent.execute().
      disableAPI: true,
      experimental: true,
      model: {
        modelName: input.config.model.modelString,
        ...(input.config.model.apiKey ? { apiKey: input.config.model.apiKey } : {}),
        ...(input.config.model.baseURL ? { baseURL: input.config.model.baseURL } : {}),
      },
      localBrowserLaunchOptions: {
        headless: input.config.headless,
        args: ['--no-sandbox'],
        ...(this.deps.env.CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: this.deps.env.CHROMIUM_EXECUTABLE_PATH }
          : {}),
      },
      verbose: 0,
      disablePino: true,
      logger: (line) => log.debug({ stagehand: line.message }, 'stagehand'),
      waitForCaptchaSolves: false,
    });

    try {
      try {
        await stagehand.init();
      } catch (err) {
        throw new AgentError('browser_crashed', `agent browser failed to launch: ${String(err)}`);
      }
      const page = stagehand.context.activePage() ?? (await stagehand.context.newPage());
      await page.goto(input.url, { waitUntil: 'domcontentloaded' });
      await this.assertNoCaptcha(stagehand);

      // Structured learn: drive the form one field at a time with act(). Stagehand returns the selector
      // it operated on, and we already KNOW each value's data key (we're filling data[key]), so
      // provenance is exact and direct (ARCHITECTURE §4 — from the call, never a page-text scan). We do
      // NOT record from the autonomous agent(): its history surfaces fills as value-less clicks, which
      // don't compile into a replayable {{data.*}} stream.
      const recorded: RecordedAction[] = [{ op: 'goto', url: input.url }];
      for (const [key, raw] of Object.entries(input.data)) {
        this.checkAbort(input.signal);
        const value = String(raw);
        const r = await stagehand.act(`Type "${value}" into the ${humanizeKey(key)} field.`);
        const selector = pickActedSelector(r.actions);
        if (selector) recorded.push({ op: 'fill', selector, value, dataProvenance: key });
        else runLogger(input.runId).warn({ key }, 'no selector captured for a fill — field dropped');
      }

      this.checkAbort(input.signal);
      const submit = await stagehand.act('Click the button that submits or searches the form.');
      const submitSelector = submit.actions[0]?.selector;
      if (submitSelector) recorded.push({ op: 'click', selector: submitSelector });
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await this.assertNoCaptcha(stagehand);

      // Domain confinement: the agent must not have wandered off the target's registrable domain.
      const finalUrl = stagehand.context.activePage()?.url() ?? input.url;
      if (!input.config.allowOffsite && isOffSite(input.url, finalUrl)) {
        throw new AgentError('navigation_failed', `agent navigated off-site to ${finalUrl}`);
      }

      let extraction: { fields: ExtractionFields | null; result: Record<string, unknown> | null; errors: AgentLearnResult['extractionErrors'] } =
        { fields: null, result: null, errors: [] };
      if (input.outputFormat) {
        extraction = await this.extract(stagehand, input.outputFormat, target.toString());
        // Make replay wait for the results to render before the structural extract runs.
        const anchor = extraction.fields ? Object.values(extraction.fields)[0] : undefined;
        if (anchor) recorded.push({ op: 'wait_for', selector: anchor });
      }

      if (input.config.captureEvidence) await this.captureEvidence(stagehand, input.runId);

      return {
        recorded,
        extractionFields: extraction.fields,
        scopeSelector: null,
        result: extraction.result,
        extractionErrors: extraction.errors,
        usage: await this.readUsage(stagehand),
      };
    } catch (err) {
      if (err instanceof AgentError) throw err;
      throw new AgentError('internal_error', `agent run failed: ${String(err)}`);
    } finally {
      await stagehand.close({ force: true }).catch(() => undefined);
    }
  }

  private checkAbort(signal: AbortSignal): void {
    if (signal.aborted) throw new AgentError('timeout', 'agent run exceeded the wall clock');
  }

  /** Sum act/extract/observe token usage for the economics note (learn cost vs ~free replay). */
  private async readUsage(stagehand: Stagehand): Promise<{ inputTokens: number; outputTokens: number } | null> {
    try {
      const m = await stagehand.metrics;
      return {
        inputTokens: m.actPromptTokens + m.extractPromptTokens + m.observePromptTokens,
        outputTokens: m.actCompletionTokens + m.extractCompletionTokens + m.observeCompletionTokens,
      };
    } catch {
      return null;
    }
  }

  private async assertNoCaptcha(stagehand: Stagehand): Promise<void> {
    const page = stagehand.context.activePage();
    if (!page) return;
    for (const sel of CAPTCHA_SELECTORS) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) throw new AgentError('captcha_detected', `CAPTCHA detected (${sel})`);
      } catch (err) {
        if (err instanceof AgentError) throw err;
        // a locator error is not a captcha signal — ignore
      }
    }
  }

  /** Extract via Stagehand, then resolve a selector per field (observe, cached) for structural replay. */
  private async extract(
    stagehand: Stagehand,
    outputFormat: Record<string, unknown>,
    url: string,
  ): Promise<{ fields: ExtractionFields; result: Record<string, unknown> | null; errors: AgentLearnResult['extractionErrors'] }> {
    const errors: AgentLearnResult['extractionErrors'] = [];
    let result: Record<string, unknown> | null = null;
    try {
      const schema = outputFormatToZod(outputFormat);
      result = (await stagehand.extract('Extract the requested fields from the page.', schema)) as Record<string, unknown>;
    } catch (err) {
      throw new AgentError('extraction_failed', `extraction failed: ${String(err)}`);
    }

    const fields: ExtractionFields = {};
    for (const field of Object.keys(outputFormat)) {
      const instruction = `the element showing the ${humanizeKey(field)}`;
      const cached = await this.deps.selectorCache.get(url, instruction);
      if (cached) {
        fields[field] = cached.selector;
        continue;
      }
      try {
        const candidates = await stagehand.observe(instruction);
        const first = candidates[0];
        if (first?.selector) {
          fields[field] = first.selector;
          await this.deps.selectorCache.set(url, instruction, { selector: first.selector, fallbackSelectors: [] });
        } else {
          errors.push({ field, reason: 'no_selector_found' });
        }
      } catch {
        errors.push({ field, reason: 'no_selector_found' });
      }
    }
    return { fields, result, errors };
  }

  private async captureEvidence(stagehand: Stagehand, runId: string): Promise<void> {
    try {
      const page = stagehand.context.activePage();
      if (!page) return;
      const screenshot = await page.screenshot({ fullPage: true });
      const html = await page.evaluate<string>('document.documentElement.outerHTML');
      await this.deps.evidence.save(runId, screenshot, html);
    } catch {
      // evidence is best-effort; never fail a run over it
    }
  }
}

/** "license_number" → "license number" for a natural-language act()/observe() instruction. */
function humanizeKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').trim();
}

/** From an act() result, the selector of the element actually operated on (prefer a fill/type action). */
function pickActedSelector(actions: ReadonlyArray<{ selector: string; method?: string }>): string | undefined {
  const typed = actions.find((a) => ['fill', 'type', 'settext'].includes((a.method ?? '').toLowerCase()));
  return (typed ?? actions[actions.length - 1] ?? actions[0])?.selector;
}

/** Map an `output_format` hint object to a Zod schema for Stagehand `extract()`. */
function outputFormatToZod(outputFormat: Record<string, unknown>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [field, hint] of Object.entries(outputFormat)) {
    const h = typeof hint === 'string' ? hint.toLowerCase() : '';
    if (h.startsWith('number')) shape[field] = z.number();
    else if (h.startsWith('boolean')) shape[field] = z.boolean();
    else if (h.startsWith('array')) shape[field] = z.array(z.string());
    else shape[field] = z.string();
  }
  return z.object(shape);
}
