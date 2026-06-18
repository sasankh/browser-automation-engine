export interface SavedEvidence {
  screenshotUrl: string | null;
  htmlUrl: string | null;
}

/** Backend-agnostic evidence storage, keyed by run_id (ARCHITECTURE §8.1). Local + S3 (Phase 6). */
export interface EvidenceStore {
  save(runId: string, screenshot: Buffer, html: string): Promise<SavedEvidence>;
  readFile(runId: string, name: string): Promise<Buffer | null>;
  /**
   * A short-lived redirect URL for this artifact, or null to serve the bytes inline. S3 returns a
   * freshly-presigned URL so the engine 302-redirects instead of proxying (DECISIONS #31); local
   * returns null (the engine serves the bytes). Keeps `meta.evidence` the same engine path in both.
   */
  urlFor(runId: string, name: string): Promise<string | null>;
}
