import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvConfig } from '../shared/env';
import { logger } from '../shared/logger';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
/** Fixed key for the migration advisory lock — serializes concurrent migrators. */
const MIGRATION_LOCK_KEY = 4_927_001;

/**
 * Lightweight forward-only SQL migrator (ARCHITECTURE §12 "node-pg-migrate or similar").
 * Applies each unapplied `migrations/NNNN_*.sql` in a transaction; records it in `schema_migrations`.
 * Runs automatically on engine start and via `npm run migrate`. A session-level advisory lock (held on
 * one dedicated connection) serializes concurrent callers — multiple engine replicas at boot, or
 * parallel test files all calling this at once — so the same unapplied migration is never applied twice.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const appliedRes = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(appliedRes.rows.map((r) => r.name));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ migration: file }, 'applied migration');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

// CLI entry: `npm run migrate`.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnvConfig();
  const pool = new pg.Pool({ connectionString: env.databaseUrl });
  runMigrations(pool)
    .then(() => pool.end())
    .then(() => {
      logger.info('migrations complete');
      process.exit(0);
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
