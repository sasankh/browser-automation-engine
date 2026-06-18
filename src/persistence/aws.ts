import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { EnvConfig } from '../shared/env';

/**
 * AWS SDK v3 clients honoring a custom endpoint so the SAME adapters hit LocalStack in dev and real
 * AWS in prod (DECISIONS #29). When an endpoint is set we use path-style S3 + static throwaway
 * credentials (LocalStack accepts any); otherwise the default provider chain (env / IAM role) is used.
 */
function localstackCreds(): { accessKeyId: string; secretAccessKey: string } {
  return { accessKeyId: 'test', secretAccessKey: 'test' };
}

export function makeS3Client(env: EnvConfig): S3Client {
  const endpoint = env.s3Endpoint ?? env.awsEndpointUrl;
  return new S3Client({
    region: env.awsRegion,
    ...(endpoint ? { endpoint, forcePathStyle: true, credentials: localstackCreds() } : {}),
  });
}

export function makeSqsClient(env: EnvConfig): SQSClient {
  const endpoint = env.awsEndpointUrl;
  return new SQSClient({
    region: env.awsRegion,
    ...(endpoint ? { endpoint, credentials: localstackCreds() } : {}),
  });
}
