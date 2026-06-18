import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlaybookStore } from './store';
import type { PlaybookMeta } from '../../types/playbook';

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/** Local-filesystem playbook bodies: `{base}/playbooks/{id}/meta.json` + `vN.json` (DATA_MODEL §3). */
export class LocalPlaybookStore implements PlaybookStore {
  constructor(private readonly basePath: string) {}

  private dir(id: string): string {
    return join(this.basePath, 'playbooks', id);
  }

  async readMeta(id: string): Promise<PlaybookMeta | null> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), 'meta.json'), 'utf8')) as PlaybookMeta;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async writeMeta(id: string, meta: PlaybookMeta): Promise<void> {
    await mkdir(this.dir(id), { recursive: true });
    await writeFile(join(this.dir(id), 'meta.json'), JSON.stringify(meta, null, 2));
  }

  async readVersionBody(id: string, version: number): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), `v${version}.json`), 'utf8'));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async writeVersionBody(id: string, version: number, body: unknown): Promise<void> {
    await mkdir(this.dir(id), { recursive: true });
    await writeFile(join(this.dir(id), `v${version}.json`), JSON.stringify(body, null, 2));
  }

  async listIds(): Promise<string[]> {
    try {
      const entries = await readdir(join(this.basePath, 'playbooks'), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }
}
