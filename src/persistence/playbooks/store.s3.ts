import { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { PlaybookStore } from './store';
import type { PlaybookMeta } from '../../types/playbook';

/** True for an S3 "object not found" (NoSuchKey / 404), so reads return null like the local store. */
export function isNoSuchKey(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

/** S3 playbook bodies under the SAME layout as local: `playbooks/{id}/meta.json` + `vN.json`. */
export class S3PlaybookStore implements PlaybookStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  private key(id: string, suffix: string): string {
    return `playbooks/${id}/${suffix}`;
  }

  private async getJson(key: string): Promise<unknown | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = await res.Body?.transformToString();
      return body === undefined ? null : JSON.parse(body);
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  private async putJson(key: string, value: unknown): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: JSON.stringify(value, null, 2), ContentType: 'application/json' }),
    );
  }

  async readMeta(id: string): Promise<PlaybookMeta | null> {
    return (await this.getJson(this.key(id, 'meta.json'))) as PlaybookMeta | null;
  }

  async writeMeta(id: string, meta: PlaybookMeta): Promise<void> {
    await this.putJson(this.key(id, 'meta.json'), meta);
  }

  async readVersionBody(id: string, version: number): Promise<unknown | null> {
    return this.getJson(this.key(id, `v${version}.json`));
  }

  async writeVersionBody(id: string, version: number, body: unknown): Promise<void> {
    await this.putJson(this.key(id, `v${version}.json`), body);
  }

  async listIds(): Promise<string[]> {
    const ids = new Set<string>();
    let token: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: 'playbooks/', Delimiter: '/', ContinuationToken: token }),
      );
      for (const cp of res.CommonPrefixes ?? []) {
        const m = cp.Prefix?.match(/^playbooks\/([^/]+)\//);
        if (m?.[1]) ids.add(m[1]);
      }
      token = res.NextContinuationToken;
    } while (token);
    return [...ids];
  }
}
