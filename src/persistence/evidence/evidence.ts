export interface SavedEvidence {
  screenshotUrl: string | null;
  htmlUrl: string | null;
}

/** Backend-agnostic evidence storage, keyed by run_id (ARCHITECTURE §8.1). Local now; S3 in Phase 6. */
export interface EvidenceStore {
  save(runId: string, screenshot: Buffer, html: string): Promise<SavedEvidence>;
  readFile(runId: string, name: string): Promise<Buffer | null>;
}
