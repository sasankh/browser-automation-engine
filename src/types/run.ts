/** Run status vocabulary (PROJECT_SPEC §7). */
export const RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'completed_with_extraction_errors',
  'failed',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'completed_with_extraction_errors',
  'failed',
]);

export type RunMode = 'playbook' | 'agent';
export type PlaybookType = 'extraction' | 'action';
