import type { ErrorCode } from '../types/errors';

/**
 * Self-heal failure classification — the normative §7 heal-eligibility table (PROJECT_SPEC §7,
 * ARCHITECTURE §6.4). This is the highest-leverage correctness surface in the phase: a wrong
 * classification either burns agent tokens healing un-healable failures or silently rots playbooks.
 * Every error code has exactly one policy; the exhaustive switch (with `noFallthroughCasesInSwitch`)
 * makes a missing code a compile error.
 */
export type HealPolicy =
  | 'heal' // escalate to an agent re-learn → new version
  | 'infra_retry' // re-run the same mode once (transient infra), not agent re-exploration
  | 'none'; // surface the failure as-is; healing won't help

export interface HealClassifyOptions {
  /** Resolved `self_heal_on_extraction_failure` — the only config that flips an `extraction_failed`. */
  selfHealOnExtractionFailure: boolean;
}

export function healPolicyForError(code: ErrorCode, opts: HealClassifyOptions): HealPolicy {
  switch (code) {
    case 'step_failed': // broken selector — the canonical redesign signal
    case 'navigation_failed': // page/URL structure moved
      return 'heal';
    case 'extraction_failed': // fields may have moved — heal only when opted in
      return opts.selfHealOnExtractionFailure ? 'heal' : 'none';
    case 'browser_crashed': // transient infra — retry the same mode once, don't re-explore
      return 'infra_retry';
    case 'captcha_detected': // a re-run won't pass a CAPTCHA
    case 'timeout': // a re-run would likely time out again; surfaces a real problem
    case 'validation_error': // caller input problem, not a site problem
    case 'playbook_not_found': // nothing to heal; caller error
    case 'agent_gave_up': // the agent already tried; auto-retry just burns tokens
    case 'internal_error': // surfaced for investigation
      return 'none';
  }
}

/**
 * A structural extraction MISS (status `completed_with_extraction_errors`) escalates to a heal only
 * when `self_heal_on_extraction_failure` is set — and only AFTER the cheaper LLM fallback has already
 * been tried by the runner (fallback-first-then-heal, DECISIONS #26).
 */
export function shouldHealExtractionMiss(opts: HealClassifyOptions): boolean {
  return opts.selfHealOnExtractionFailure;
}
