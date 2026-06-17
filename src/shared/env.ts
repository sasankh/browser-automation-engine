/**
 * Process-wide, env-only operational config (destinations, capacity, mode). Loaded once at boot
 * and threaded explicitly — business logic must never read `process.env` directly. Per-run
 * behavior config is resolved separately by the ConfigResolver (payload > env > default).
 */
export type ServiceMode = 'all' | 'api' | 'worker';
export type StorageBackend = 'local' | 's3';
export type AuthMode = 'none' | 'api_key' | 'hmac';

export interface EnvConfig {
  serviceMode: ServiceMode;
  port: number;
  databaseUrl: string;
  storageBackend: StorageBackend;
  storageLocalPath: string;
  // Capacity (per-container). Values loaded now; enforcement lands in Phase 3.
  maxConcurrentRuns: number;
  maxQueueDepth: number;
  runTimeoutSeconds: number;
  maxRunTimeoutSeconds: number;
  browserRecycleRuns: number;
  shutdownGraceSeconds: number;
  authMode: AuthMode;
  // Self-heal & fallback-drift (Phase 5).
  healFailureThreshold: number; // consecutive heal failures before health=unhealthy
  fallbackAsDriftSignal: boolean; // flag a playbook for re-learn after K fallback engagements
  fallbackDriftThreshold: number; // K
  // Transports & storage backends (Phase 6).
  sqsEnabled: boolean;
  sqsQueueUrl: string | undefined;
  sqsResultsQueueUrl: string | undefined; // optional: publish the envelope here on terminal
  sqsVisibilityTimeoutSeconds: number; // per-receive visibility; the consumer heartbeats to extend it
  awsRegion: string;
  awsEndpointUrl: string | undefined; // custom endpoint (LocalStack in dev) for SQS + S3
  s3Bucket: string | undefined;
  s3Endpoint: string | undefined; // S3-specific endpoint override (defaults to awsEndpointUrl)
  webhookMaxRetries: number;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid integer env ${key}: ${raw}`);
  return n;
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  return raw === 'true' || raw === '1' || raw === 'on';
}

function strEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  return raw === undefined || raw === '' ? undefined : raw;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], def: T): T {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`Invalid value for ${key}: ${raw} (expected one of ${allowed.join(', ')})`);
  }
  return raw as T;
}

export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  return Object.freeze({
    serviceMode: oneOf(env, 'SERVICE_MODE', ['all', 'api', 'worker'] as const, 'all'),
    port: intEnv(env, 'PORT', 8080),
    databaseUrl,
    storageBackend: oneOf(env, 'STORAGE_BACKEND', ['local', 's3'] as const, 'local'),
    storageLocalPath: env.STORAGE_LOCAL_PATH ?? './data',
    maxConcurrentRuns: intEnv(env, 'MAX_CONCURRENT_RUNS', 3),
    maxQueueDepth: intEnv(env, 'MAX_QUEUE_DEPTH', 20),
    runTimeoutSeconds: intEnv(env, 'RUN_TIMEOUT_SECONDS', 180),
    maxRunTimeoutSeconds: intEnv(env, 'MAX_RUN_TIMEOUT_SECONDS', 600),
    browserRecycleRuns: intEnv(env, 'BROWSER_RECYCLE_RUNS', 10),
    shutdownGraceSeconds: intEnv(env, 'SHUTDOWN_GRACE_SECONDS', 25),
    authMode: oneOf(env, 'API_AUTH_MODE', ['none', 'api_key', 'hmac'] as const, 'none'),
    healFailureThreshold: intEnv(env, 'HEAL_FAILURE_THRESHOLD', 3),
    fallbackAsDriftSignal: boolEnv(env, 'FALLBACK_AS_DRIFT_SIGNAL', false),
    fallbackDriftThreshold: intEnv(env, 'FALLBACK_DRIFT_THRESHOLD', 5),
    sqsEnabled: boolEnv(env, 'SQS_ENABLED', false),
    sqsQueueUrl: strEnv(env, 'SQS_QUEUE_URL'),
    sqsResultsQueueUrl: strEnv(env, 'SQS_RESULTS_QUEUE_URL'),
    sqsVisibilityTimeoutSeconds: intEnv(env, 'SQS_VISIBILITY_TIMEOUT_SECONDS', 300),
    awsRegion: env.AWS_REGION ?? 'us-east-1',
    awsEndpointUrl: strEnv(env, 'AWS_ENDPOINT_URL'),
    s3Bucket: strEnv(env, 'S3_BUCKET'),
    s3Endpoint: strEnv(env, 'S3_ENDPOINT'),
    webhookMaxRetries: intEnv(env, 'WEBHOOK_MAX_RETRIES', 3),
  });
}
