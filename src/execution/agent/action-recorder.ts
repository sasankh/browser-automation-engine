import type { RecordedAction } from './recorded-action';
import type { ProvenanceIndex } from './provenance';

/**
 * Reconstructs the effective action stream from Stagehand's call history, tagging each typed value
 * with its `data` key by value identity (ARCHITECTURE §4.1). Typed against minimal local shapes (not
 * Stagehand's exported types) so it stays import-free of Stagehand and unit-testable offline — the
 * agent engine feeds it `stagehand.history`, which is structurally compatible.
 */
export interface StagehandActionLike {
  selector: string;
  description?: string;
  method?: string;
  arguments?: string[];
}

export interface StagehandHistoryLike {
  method: string; // "act" | "extract" | "observe" | "navigate" | "agent"
  parameters: unknown;
  result: unknown;
}

export interface RecordResult {
  actions: RecordedAction[];
  /** Stagehand action methods we couldn't map to the fixed op vocabulary (surfaced, never silent). */
  skipped: string[];
}

/** Stagehand `Action.method` → our declarative op. Unknown methods are reported in `skipped`. */
function mapMethod(method: string | undefined): RecordedAction['op'] | null {
  switch ((method ?? '').toLowerCase()) {
    case 'click':
      return 'click';
    case 'fill':
    case 'type':
    case 'settext':
      return 'fill';
    case 'selectoption':
    case 'select':
      return 'select';
    case 'check':
      return 'check';
    case 'press':
      return 'press';
    case 'scrollintoview':
    case 'scroll':
      return 'scroll';
    case 'waitforselector':
    case 'waitfor':
      return 'wait_for';
    default:
      return null;
  }
}

function navUrl(parameters: unknown): string | null {
  if (typeof parameters === 'string') return parameters;
  if (parameters && typeof parameters === 'object' && 'url' in parameters) {
    const u = (parameters as { url: unknown }).url;
    if (typeof u === 'string') return u;
  }
  return null;
}

function actionsOf(result: unknown): StagehandActionLike[] {
  if (result && typeof result === 'object' && 'actions' in result) {
    const a = (result as { actions: unknown }).actions;
    if (Array.isArray(a)) return a as StagehandActionLike[];
  }
  return [];
}

export function recordActions(history: StagehandHistoryLike[], provenance: ProvenanceIndex): RecordResult {
  const actions: RecordedAction[] = [];
  const skipped: string[] = [];

  for (const entry of history) {
    if (entry.method === 'navigate') {
      const url = navUrl(entry.parameters);
      if (url) actions.push({ op: 'goto', url });
      continue;
    }
    if (entry.method !== 'act') continue; // observe/extract/agent aren't effective actions

    for (const a of actionsOf(entry.result)) {
      const op = mapMethod(a.method);
      if (op === null) {
        skipped.push(a.method ?? '(unknown)');
        continue;
      }
      const action: RecordedAction = { op, selector: a.selector };
      if (a.description) action.description = a.description;

      if (op === 'fill' || op === 'select') {
        const value = a.arguments?.[0] ?? '';
        action.value = value;
        action.dataProvenance = provenance.tag(value); // identity match → key, else null (literal)
      } else if (op === 'press') {
        action.key = a.arguments?.[0] ?? 'Enter';
      }
      actions.push(action);
    }
  }

  return { actions, skipped };
}
