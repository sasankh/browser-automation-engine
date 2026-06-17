import { describe, it, expect, beforeAll } from 'vitest';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadEnvConfig } from '../../src/shared/env';
import { makeS3Client } from '../../src/persistence/aws';
import { S3PlaybookStore } from '../../src/persistence/playbooks/store.s3';
import { S3EvidenceStore } from '../../src/persistence/evidence/evidence.s3';
import { S3SelectorCache } from '../../src/persistence/cache/selector-cache.s3';
import type { PlaybookMeta } from '../../src/types/playbook';

// S3 storage adapters round-tripped against LocalStack (DECISIONS #29). Needs `docker compose up -d
// localstack`. Same layout/prefixes as the local stores; presigned evidence URL must resolve.
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const BUCKET = 'rote';

const env = loadEnvConfig({
  DATABASE_URL: 'postgres://unused',
  AWS_ENDPOINT_URL: ENDPOINT,
  S3_BUCKET: BUCKET,
  AWS_REGION: 'us-east-1',
} as NodeJS.ProcessEnv);

let s3: S3Client;

beforeAll(async () => {
  s3 = makeS3Client(env);
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined); // idempotent
});

describe('Phase 6 — S3 storage adapters (LocalStack)', () => {
  it('S3PlaybookStore round-trips meta + version bodies and lists ids', async () => {
    const store = new S3PlaybookStore(s3, BUCKET);
    const id = `pb_s3test_${Date.now()}`;
    const meta = { playbook_id: id, active_version: 1, instruction: 'x' } as unknown as PlaybookMeta;
    await store.writeMeta(id, meta);
    await store.writeVersionBody(id, 1, { version: 1, hello: 'world' });

    expect(await store.readMeta(id)).toMatchObject({ playbook_id: id, active_version: 1 });
    expect(await store.readVersionBody(id, 1)).toMatchObject({ version: 1, hello: 'world' });
    expect(await store.readVersionBody(id, 99)).toBeNull(); // miss → null, like local
    expect(await store.listIds()).toContain(id);
  });

  it('S3EvidenceStore saves + serves bytes, and urlFor presigns a resolvable URL', async () => {
    const store = new S3EvidenceStore(s3, BUCKET);
    const runId = `run_s3test_${Date.now()}`;
    const png = Buffer.from('\x89PNG\r\n fake', 'binary');
    await store.save(runId, png, '<html>evidence</html>');

    const html = await store.readFile(runId, 'page.html');
    expect(html?.toString()).toBe('<html>evidence</html>');
    expect(await store.readFile(runId, '../etc/passwd')).toBeNull(); // traversal guard

    const url = await store.urlFor(runId, 'screenshot.png');
    expect(url).toMatch(/screenshot\.png/);
    const fetched = await fetch(url as string); // presigned → directly resolvable
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(png);
  });

  it('S3SelectorCache round-trips and misses return null', async () => {
    const cache = new S3SelectorCache(s3, BUCKET);
    await cache.set('http://site/x', 'the field', { selector: '#a', fallbackSelectors: ['#b'] });
    expect(await cache.get('http://site/x', 'the field')).toEqual({ selector: '#a', fallbackSelectors: ['#b'] });
    expect(await cache.get('http://site/x', 'never set')).toBeNull();
  });
});
