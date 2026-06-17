import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { EvidenceStore, SavedEvidence } from './evidence';

const ALLOWED = new Set(['screenshot.png', 'page.html']);

/** Evidence under `{base}/evidence/{run_id}/`; the envelope carries engine-served paths. */
export class LocalEvidenceStore implements EvidenceStore {
  constructor(private readonly basePath: string) {}

  private dir(runId: string): string {
    return join(this.basePath, 'evidence', runId);
  }

  async save(runId: string, screenshot: Buffer, html: string): Promise<SavedEvidence> {
    await mkdir(this.dir(runId), { recursive: true });
    await writeFile(join(this.dir(runId), 'screenshot.png'), screenshot);
    await writeFile(join(this.dir(runId), 'page.html'), html);
    return {
      screenshotUrl: `/v1/runs/${runId}/evidence/screenshot.png`,
      htmlUrl: `/v1/runs/${runId}/evidence/page.html`,
    };
  }

  async readFile(runId: string, name: string): Promise<Buffer | null> {
    // Guard against traversal: only the two known artifact names are served.
    const safe = basename(name);
    if (!ALLOWED.has(safe)) return null;
    try {
      return await readFile(join(this.dir(runId), safe));
    } catch {
      return null;
    }
  }
}
