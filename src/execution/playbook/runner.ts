import type { Page } from 'playwright';
import { executeStep, evaluateAssertion, StepError } from './step-interpreter';
import type { RunData } from './step-interpreter';
import { structuralExtract } from './structural-extractor';
import type { PlaybookVersion } from './playbook-schema';
import type { RunError, ExtractionError } from '../../types/errors';
import type { RunStatus } from '../../types/run';
import type { EvidenceStore } from '../../persistence/evidence/evidence';

export interface RunInput {
  runId: string;
  /** The page is supplied by the lifecycle/pool — the runner never acquires or closes a context. */
  page: Page;
  playbook: PlaybookVersion;
  data: RunData;
  defaultTimeoutMs: number;
  captureEvidence: boolean;
}

export interface RunOutcome {
  status: RunStatus;
  result: Record<string, unknown> | null;
  error: RunError | null;
  extractionErrors: ExtractionError[] | null;
  evidenceCaptured: boolean;
}

/**
 * The deterministic, zero-LLM replay path. Imports no Stagehand/Anthropic — interprets the fixed op
 * vocabulary over the supplied Playwright page, extracts structurally, captures evidence. Context
 * lifecycle (acquisition, the wall-clock timeout teardown) is owned by the lifecycle/pool above it.
 */
export class PlaybookRunner {
  constructor(private readonly evidence: EvidenceStore) {}

  async run(input: RunInput): Promise<RunOutcome> {
    const { runId, page, playbook, data, defaultTimeoutMs, captureEvidence } = input;

    let status: RunStatus = 'completed';
    let result: Record<string, unknown> | null = null;
    let error: RunError | null = null;
    let extractionErrors: ExtractionError[] = [];

    try {
      for (const [index, step] of playbook.steps.entries()) {
        if (step.op === 'extract') {
          const ext = await structuralExtract(page, step, playbook.output_format ?? null);
          result = ext.result;
          extractionErrors = ext.extractionErrors;
        } else {
          await executeStep(step, index, { page, data, defaultTimeoutMs });
        }
        for (const assertion of playbook.assertions ?? []) {
          if (assertion.after_step === index) {
            await evaluateAssertion(assertion, index, page, defaultTimeoutMs);
          }
        }
      }

      if (playbook.playbook_type === 'action') {
        status = 'completed';
        result = null;
      } else if (extractionErrors.length > 0) {
        status = 'completed_with_extraction_errors';
      } else {
        status = 'completed';
      }
    } catch (err) {
      status = 'failed';
      result = null;
      error =
        err instanceof StepError
          ? { code: err.code, step: err.stepIndex, message: err.message }
          : { code: 'internal_error', message: `runner error: ${String(err)}` };
    }

    let evidenceCaptured = false;
    if (captureEvidence) {
      try {
        const screenshot = await page.screenshot({ fullPage: true });
        const html = await page.content();
        await this.evidence.save(runId, screenshot, html);
        evidenceCaptured = true;
      } catch {
        // evidence is best-effort; never fail a run over it
      }
    }

    return {
      status,
      result,
      error,
      extractionErrors: extractionErrors.length > 0 ? extractionErrors : null,
      evidenceCaptured,
    };
  }
}
