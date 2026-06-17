/** Playbook identity + version index (DATA_MODEL §3). Bodies live in the PlaybookStore as vN.json. */
export type CreatedBy = 'agent_initial' | 'self_heal' | 'manual' | 'format_change';

export interface PlaybookVersionEntry {
  version: number;
  created_at: string;
  created_by: CreatedBy;
  run_id: string | null;
}

export interface PlaybookMeta {
  playbook_id: string;
  created_at: string;
  active_version: number;
  playbook_type: 'extraction' | 'action';
  instruction: string;
  url: string;
  required_data_keys: string[];
  deleted: boolean;
  versions: PlaybookVersionEntry[];
}
