import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { selectorCacheKey } from './selector-cache';
import type { SelectorCache, CachedSelectors } from './selector-cache';
import { isNoSuchKey } from '../playbooks/store.s3';

/** S3 selector cache: one object per key under `selector-cache/`. A miss just means re-observe. */
export class S3SelectorCache implements SelectorCache {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  private key(url: string, instruction: string): string {
    return `selector-cache/${selectorCacheKey(url, instruction)}.json`;
  }

  async get(url: string, instruction: string): Promise<CachedSelectors | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(url, instruction) }));
      const body = await res.Body?.transformToString();
      return body === undefined ? null : (JSON.parse(body) as CachedSelectors);
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  async set(url: string, instruction: string, value: CachedSelectors): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: this.key(url, instruction), Body: JSON.stringify(value), ContentType: 'application/json' }),
    );
  }
}
