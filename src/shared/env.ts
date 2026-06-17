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
  authMode: AuthMode;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid integer env ${key}: ${raw}`);
  return n;
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
    authMode: oneOf(env, 'API_AUTH_MODE', ['none', 'api_key', 'hmac'] as const, 'none'),
  });
}
