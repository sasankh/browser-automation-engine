import { describe, it, expect } from 'vitest';
import { recordActions, type StagehandHistoryLike } from '../../src/execution/agent/action-recorder';
import { ProvenanceIndex } from '../../src/execution/agent/provenance';

/** Build an `act` history entry whose result carries Stagehand `Action`s (selector/method/arguments). */
function act(actions: Array<{ selector: string; method: string; arguments?: string[]; description?: string }>): StagehandHistoryLike {
  return { method: 'act', parameters: {}, result: { actions } };
}

describe('recordActions — Stagehand history → RecordedAction[] with provenance', () => {
  const provenance = new ProvenanceIndex({ license_number: 'A123456', last_name: 'Nguyen' });

  it('maps navigate + act entries and tags typed values by identity', () => {
    const history: StagehandHistoryLike[] = [
      { method: 'navigate', parameters: { url: 'https://site/lookup' }, result: null },
      act([{ selector: '#licNum', method: 'fill', arguments: ['A123456'] }]),
      act([{ selector: '#lastNm', method: 'fill', arguments: ['Nguyen'] }]),
      act([{ selector: '#type', method: 'selectOption', arguments: ['Physician'] }]),
      act([{ selector: '#submit', method: 'click' }]),
    ];
    const { actions, skipped } = recordActions(history, provenance);

    expect(actions[0]).toEqual({ op: 'goto', url: 'https://site/lookup' });
    expect(actions[1]).toMatchObject({ op: 'fill', selector: '#licNum', value: 'A123456', dataProvenance: 'license_number' });
    expect(actions[2]).toMatchObject({ op: 'fill', selector: '#lastNm', value: 'Nguyen', dataProvenance: 'last_name' });
    // Agent-chosen literal → no provenance (will be baked in by the compiler).
    expect(actions[3]).toMatchObject({ op: 'select', selector: '#type', value: 'Physician', dataProvenance: null });
    expect(actions[4]).toMatchObject({ op: 'click', selector: '#submit' });
    expect(skipped).toEqual([]);
  });

  it('maps a string navigate parameter and a press key', () => {
    const history: StagehandHistoryLike[] = [
      { method: 'navigate', parameters: 'https://site/x', result: null },
      act([{ selector: '#q', method: 'press', arguments: ['Enter'] }]),
    ];
    const { actions } = recordActions(history, provenance);
    expect(actions[0]).toEqual({ op: 'goto', url: 'https://site/x' });
    expect(actions[1]).toMatchObject({ op: 'press', selector: '#q', key: 'Enter' });
  });

  it('surfaces (never silently drops) an op it cannot map to the vocabulary', () => {
    const { actions, skipped } = recordActions([act([{ selector: '#x', method: 'dragAndDrop' }])], provenance);
    expect(actions).toEqual([]);
    expect(skipped).toEqual(['dragAndDrop']);
  });

  it('ignores observe/extract/agent entries (not effective actions)', () => {
    const history: StagehandHistoryLike[] = [
      { method: 'observe', parameters: {}, result: { actions: [{ selector: '#a', method: 'click' }] } },
      { method: 'extract', parameters: {}, result: {} },
      { method: 'agent', parameters: {}, result: {} },
    ];
    expect(recordActions(history, provenance).actions).toEqual([]);
  });
});
