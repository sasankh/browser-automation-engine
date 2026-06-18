import { describe, it, expect } from 'vitest';
import { compilePlaybook } from '../../src/execution/agent/compiler';
import type { RecordedAction } from '../../src/execution/agent/recorded-action';

const navAndFill: RecordedAction[] = [
  { op: 'goto', url: 'https://site/lookup' },
  { op: 'fill', selector: '#licNum', value: 'A123456', dataProvenance: 'license_number' },
  { op: 'fill', selector: '#lastNm', value: 'Nguyen', dataProvenance: 'last_name' },
  { op: 'select', selector: '#type', value: 'Physician', dataProvenance: null }, // agent literal
  { op: 'click', selector: '#submit', fallbackSelectors: ['button[type=submit]'] },
  { op: 'wait_for', selector: '.results-table' },
];

describe('compilePlaybook — record → declarative playbook (ARCHITECTURE §4.2)', () => {
  it('parameterizes provenanced values and bakes in agent literals', () => {
    const pb = compilePlaybook({
      recorded: navAndFill,
      outputFormat: { license_status: 'string' },
      extractionFields: { license_status: '.status' },
      scopeSelector: '.results-table',
    });
    const byOp = (op: string, sel?: string) =>
      pb.steps.find((s) => s.op === op && (sel === undefined || s.selector === sel));

    expect(byOp('fill', '#licNum')?.value).toBe('{{data.license_number}}');
    expect(byOp('fill', '#lastNm')?.value).toBe('{{data.last_name}}');
    // Agent-chosen literal stays verbatim — it is process, not input.
    expect(byOp('select', '#type')?.value).toBe('Physician');
    // Fallback selectors carried through from observe().
    expect(byOp('click', '#submit')?.fallback_selectors).toEqual(['button[type=submit]']);
  });

  it('derives required_data_keys from the provenance set, in order, deduped', () => {
    const pb = compilePlaybook({
      recorded: navAndFill,
      outputFormat: { license_status: 'string' },
      extractionFields: { license_status: '.status' },
    });
    expect(pb.required_data_keys).toEqual(['license_number', 'last_name']);
  });

  it('appends an extract step with fields + scope for an extraction task', () => {
    const pb = compilePlaybook({
      recorded: navAndFill,
      outputFormat: { license_status: 'string', holder_name: 'string' },
      extractionFields: { license_status: '.status', holder_name: '.holder' },
      scopeSelector: '.results-table',
    });
    expect(pb.playbook_type).toBe('extraction');
    const extract = pb.steps.at(-1);
    expect(extract?.op).toBe('extract');
    expect(extract?.schema_ref).toBe('output_format');
    expect(extract?.scope_selector).toBe('.results-table');
    expect(extract?.fields).toEqual({ license_status: '.status', holder_name: '.holder' });
    expect(pb.output_format).toEqual({ license_status: 'string', holder_name: 'string' });
  });

  it('compiles an action-only playbook (no output_format) with no extract step, result-bearing fields aside', () => {
    const pb = compilePlaybook({
      recorded: [
        { op: 'goto', url: 'https://site/contact' },
        { op: 'fill', selector: '#email', value: 'a@b.c', dataProvenance: 'email' },
        { op: 'click', selector: '#send' },
      ],
      outputFormat: null,
    });
    expect(pb.playbook_type).toBe('action');
    expect(pb.output_format).toBeNull();
    expect(pb.steps.some((s) => s.op === 'extract')).toBe(false);
    expect(pb.required_data_keys).toEqual(['email']);
  });

  it('produces a body that passes the Phase-2 playbook schema (replayable by construction)', () => {
    // compilePlaybook validates internally; a throw would fail the test.
    const pb = compilePlaybook({
      recorded: navAndFill,
      outputFormat: { license_status: 'string' },
      extractionFields: { license_status: '.status' },
    });
    expect(pb.version).toBe(1);
    expect(pb.engine_min_version).toBe('1.0.0');
  });
});
