import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { basename } from 'node:path';
import type { EvidenceStore, SavedEvidence } from './evidence';
import { isNoSuchKey } from '../playbooks/store.s3';

const ALLOWED = new Set(['screenshot.png', 'page.html']);
const PRESIGN_EXPIRY_SECONDS = 300;

/** S3 evidence under `evidence/{run_id}/`; `urlFor` returns a presigned URL the engine 302s to (#31). */
export class S3EvidenceStore implements EvidenceStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  private key(runId: string, name: string): string {
    return `evidence/${runId}/${name}`;
  }

  async save(runId: string, screenshot: Buffer, html: string): Promise<SavedEvidence> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.key(runId, 'screenshot.png'), Body: screenshot, ContentType: 'image/png' }),
    );
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.key(runId, 'page.html'), Body: html, ContentType: 'text/html; charset=utf-8' }),
    );
    return {
      screenshotUrl: `/v1/runs/${runId}/evidence/screenshot.png`,
      htmlUrl: `/v1/runs/${runId}/evidence/page.html`,
    };
  }

  async readFile(runId: string, name: string): Promise<Buffer | null> {
    const safe = basename(name);
    if (!ALLOWED.has(safe)) return null;
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(runId, safe) }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  async urlFor(runId: string, name: string): Promise<string | null> {
    const safe = basename(name);
    if (!ALLOWED.has(safe)) return null;
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: this.key(runId, safe) }), {
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    });
  }
}
