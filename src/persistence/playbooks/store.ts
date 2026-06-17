import type { PlaybookMeta } from '../../types/playbook';

/**
 * Backend-agnostic storage for playbook **bodies** (`meta.json` + `vN.json`). Local impl now; S3 in
 * Phase 6 behind this same interface. Postgres is always the authoritative index (see repository).
 */
export interface PlaybookStore {
  readMeta(id: string): Promise<PlaybookMeta | null>;
  writeMeta(id: string, meta: PlaybookMeta): Promise<void>;
  readVersionBody(id: string, version: number): Promise<unknown | null>;
  writeVersionBody(id: string, version: number, body: unknown): Promise<void>;
  listIds(): Promise<string[]>;
}
