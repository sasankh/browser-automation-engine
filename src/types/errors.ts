/** Error-code set — the public contract surface (PROJECT_SPEC §7). Additive changes only. */
export const ERROR_CODES = [
  'validation_error',
  'step_failed',
  'navigation_failed',
  'timeout',
  'captcha_detected',
  'extraction_failed',
  'agent_gave_up',
  'browser_crashed',
  'playbook_not_found',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface RunError {
  code: ErrorCode;
  step?: number;
  message: string;
  heal_attempted?: boolean;
  heal_outcome?: string;
}

export interface ExtractionError {
  field: string;
  reason: string;
}
