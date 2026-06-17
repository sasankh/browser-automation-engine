import type { Db } from '../db';
import type { PlaybookStore } from './store';
import type { PlaybookMeta, CreatedBy, PlaybookVersionEntry } from '../../types/playbook';
import { parsePlaybookVersion } from '../../execution/playbook/playbook-schema';
import type { PlaybookVersion } from '../../execution/playbook/playbook-schema';

export type PlaybookType = 'extraction' | 'action';

interface PlaybookDbRow {
  id: string;
  url: string;
  instruction: string;
  playbook_type: PlaybookType;
  required_data_keys: string[];
  active_version: number;
  health: string;
  deleted: boolean;
}

interface VersionDbRow {
  version: number;
  created_at: Date;
  created_by: CreatedBy;
  created_by_run: string | null;
  output_format: Record<string, unknown> | null;
}

export interface PlaybookSummary {
  playbook_id: string;
  playbook_type: PlaybookType;
  url: string;
  required_data_keys: string[];
  active_version: number;
  health: string;
}

export interface PlaybookContract extends PlaybookSummary {
  instruction: string;
  output_format: Record<string, unknown> | null;
  versions: Array<{ version: number; created_at: string; created_by: CreatedBy; run_id: string | null }>;
}

export interface ResolvedPlaybook {
  version: number;
  required_data_keys: string[];
  playbook_type: PlaybookType;
}

export interface CreatePlaybookInput {
  id: string;
  url: string;
  instruction: string;
  body: PlaybookVersion;
  createdBy: CreatedBy;
  runId: string | null;
}

/**
 * Coordinates playbook bodies (PlaybookStore, backend-agnostic) with the Postgres index
 * (always Postgres). The `active_version` pointer move is a single transaction (ARCHITECTURE §8.1);
 * `meta.json` mirrors the index and is kept in sync on every write.
 */
export class PlaybookRepository {
  constructor(
    private readonly db: Db,
    private readonly store: PlaybookStore,
  ) {}

  private bodyUri(id: string, version: number): string {
    return `playbooks/${id}/v${version}.json`;
  }

  async create(input: CreatePlaybookInput): Promise<void> {
    const { id, url, instruction, body, createdBy, runId } = input;
    await this.store.writeVersionBody(id, 1, body);
    const now = new Date().toISOString();
    const meta: PlaybookMeta = {
      playbook_id: id,
      created_at: now,
      active_version: 1,
      playbook_type: body.playbook_type,
      instruction,
      url,
      required_data_keys: body.required_data_keys,
      deleted: false,
      versions: [{ version: 1, created_at: now, created_by: createdBy, run_id: runId }],
    };
    await this.store.writeMeta(id, meta);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO playbooks (id, url, instruction, playbook_type, required_data_keys, active_version)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [id, url, instruction, body.playbook_type, body.required_data_keys],
      );
      await client.query(
        `INSERT INTO playbook_versions (playbook_id, version, created_by, created_by_run, output_format, body_uri)
         VALUES ($1, 1, $2, $3, $4, $5)`,
        [id, createdBy, runId, body.output_format ?? null, this.bodyUri(id, 1)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Append v(n+1), write the body + index row, and move `active_version` in one transaction. */
  async addVersion(
    id: string,
    body: PlaybookVersion,
    createdBy: CreatedBy,
    runId: string | null,
  ): Promise<number> {
    const head = await this.db.query<{ active_version: number }>(
      `SELECT active_version FROM playbooks WHERE id = $1`,
      [id],
    );
    const headRow = head.rows[0];
    if (!headRow) throw new Error(`playbook not found: ${id}`);
    const next = headRow.active_version + 1;
    const normalized: PlaybookVersion = { ...body, version: next };
    await this.store.writeVersionBody(id, next, normalized);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO playbook_versions (playbook_id, version, created_by, created_by_run, output_format, body_uri)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, next, createdBy, runId, body.output_format ?? null, this.bodyUri(id, next)],
      );
      await client.query(`UPDATE playbooks SET active_version = $2 WHERE id = $1`, [id, next]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await this.syncMeta(id);
    return next;
  }

  /** Resolve which version a replay should run; null if the playbook is missing or tombstoned. */
  async resolveForReplay(id: string, pinned?: number): Promise<ResolvedPlaybook | null> {
    const res = await this.db.query<PlaybookDbRow>(`SELECT * FROM playbooks WHERE id = $1`, [id]);
    const row = res.rows[0];
    if (!row || row.deleted) return null;
    const version = pinned ?? row.active_version;
    return { version, required_data_keys: row.required_data_keys, playbook_type: row.playbook_type };
  }

  async loadVersion(id: string, version: number): Promise<PlaybookVersion | null> {
    const body = await this.store.readVersionBody(id, version);
    if (body === null) return null;
    return parsePlaybookVersion(body);
  }

  async list(healthFilter?: string): Promise<PlaybookSummary[]> {
    const params: unknown[] = [];
    let where = 'deleted = false';
    if (healthFilter) {
      params.push(healthFilter);
      where += ` AND health = $${params.length}`;
    }
    const res = await this.db.query<PlaybookDbRow>(
      `SELECT * FROM playbooks WHERE ${where} ORDER BY created_at DESC`,
      params,
    );
    return res.rows.map((r) => ({
      playbook_id: r.id,
      playbook_type: r.playbook_type,
      url: r.url,
      required_data_keys: r.required_data_keys,
      active_version: r.active_version,
      health: r.health,
    }));
  }

  async getContract(id: string): Promise<PlaybookContract | null> {
    const res = await this.db.query<PlaybookDbRow>(`SELECT * FROM playbooks WHERE id = $1`, [id]);
    const row = res.rows[0];
    if (!row) return null;
    const vres = await this.db.query<VersionDbRow>(
      `SELECT version, created_at, created_by, created_by_run, output_format
       FROM playbook_versions WHERE playbook_id = $1 ORDER BY version`,
      [id],
    );
    const active = vres.rows.find((v) => v.version === row.active_version);
    return {
      playbook_id: row.id,
      playbook_type: row.playbook_type,
      url: row.url,
      instruction: row.instruction,
      required_data_keys: row.required_data_keys,
      active_version: row.active_version,
      health: row.health,
      output_format: active?.output_format ?? null,
      versions: vres.rows.map((v) => ({
        version: v.version,
        created_at: v.created_at.toISOString(),
        created_by: v.created_by,
        run_id: v.created_by_run,
      })),
    };
  }

  /** Move the active pointer to an existing version (rollback / activate). Returns false if missing. */
  async activate(id: string, version: number): Promise<boolean> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query(
        `SELECT 1 FROM playbook_versions WHERE playbook_id = $1 AND version = $2`,
        [id, version],
      );
      if (exists.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(`UPDATE playbooks SET active_version = $2 WHERE id = $1`, [id, version]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await this.syncMeta(id);
    return true;
  }

  async softDelete(id: string): Promise<boolean> {
    const res = await this.db.query(`UPDATE playbooks SET deleted = true WHERE id = $1`, [id]);
    if (res.rowCount === 0) return false;
    await this.syncMeta(id);
    return true;
  }

  /** Re-derive `meta.json` from the authoritative Postgres index. */
  private async syncMeta(id: string): Promise<void> {
    const contract = await this.getContract(id);
    const existing = await this.store.readMeta(id);
    if (!contract || !existing) return;
    const versions: PlaybookVersionEntry[] = contract.versions.map((v) => ({
      version: v.version,
      created_at: v.created_at,
      created_by: v.created_by,
      run_id: v.run_id,
    }));
    await this.store.writeMeta(id, {
      ...existing,
      active_version: contract.active_version,
      required_data_keys: contract.required_data_keys,
      deleted: await this.isDeleted(id),
      versions,
    });
  }

  private async isDeleted(id: string): Promise<boolean> {
    const res = await this.db.query<{ deleted: boolean }>(`SELECT deleted FROM playbooks WHERE id = $1`, [id]);
    return res.rows[0]?.deleted ?? false;
  }
}
