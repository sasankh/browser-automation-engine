import { ulid } from 'ulidx';

/** ULID-backed, prefixed identifiers (DECISIONS #9). Sortable, coordination-free. */
export function newRunId(): string {
  return `run_${ulid()}`;
}

export function newPlaybookId(): string {
  return `pb_${ulid()}`;
}
