import pg from 'pg';
import type { EnvConfig } from '../shared/env';

/** A pooled Postgres handle. Everything above persistence treats this as an opaque store. */
export type Db = pg.Pool;

export function createDb(env: EnvConfig): Db {
  return new pg.Pool({ connectionString: env.databaseUrl });
}
