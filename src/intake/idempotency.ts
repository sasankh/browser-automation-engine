import type { Db } from '../persistence/db';

/**
 * `(caller, idempotency_key)` is unique. A repeat returns the original run, never a second one.
 * Under `API_AUTH_MODE=none` the caller is a constant ("default"), so idempotency is global by key.
 */
export class IdempotencyGuard {
  constructor(private readonly db: Db) {}

  async lookup(caller: string, key: string): Promise<string | null> {
    const res = await this.db.query<{ run_id: string }>(
      `SELECT run_id FROM idempotency_keys WHERE caller = $1 AND idempotency_key = $2`,
      [caller, key],
    );
    return res.rows[0]?.run_id ?? null;
  }

  /** Record (caller,key)->runId; returns the WINNING run_id (ours, or the existing one on conflict). */
  async record(caller: string, key: string, runId: string): Promise<string> {
    const res = await this.db.query<{ run_id: string }>(
      `INSERT INTO idempotency_keys (caller, idempotency_key, run_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (caller, idempotency_key) DO NOTHING
       RETURNING run_id`,
      [caller, key, runId],
    );
    if (res.rows[0]) return res.rows[0].run_id;
    const winner = await this.lookup(caller, key);
    return winner ?? runId;
  }
}
