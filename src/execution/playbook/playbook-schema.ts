import { z } from 'zod';

/**
 * Declarative playbook version file (`vN.json`) — DATA_MODEL §4. Validated on every load.
 * Nothing here is ever executed as code; the interpreter maps a fixed op vocabulary to Playwright.
 * The step shape is flat (matching the documented JSON Schema); per-op required fields are enforced
 * by the interpreter, which keeps this schema and the op handlers in lockstep.
 */
export const OPS = [
  'goto',
  'click',
  'fill',
  'select',
  'check',
  'press',
  'wait_for',
  'wait_ms',
  'scroll',
  'extract',
  'screenshot',
] as const;
export type Op = (typeof OPS)[number];

export const StepSchema = z
  .object({
    op: z.enum(OPS),
    url: z.string().optional(),
    selector: z.string().optional(),
    fallback_selectors: z.array(z.string()).optional(),
    value: z.string().optional(),
    key: z.string().optional(),
    ms: z.number().int().min(0).optional(),
    timeout_ms: z.number().int().min(0).optional(),
    to: z.string().optional(),
    scope_selector: z.string().optional(),
    // extract: maps each output_format field -> a selector relative to scope_selector (DECISIONS #14).
    fields: z.record(z.string(), z.string()).optional(),
    schema_ref: z.literal('output_format').optional(),
    label: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;

export const AssertionSchema = z.object({
  after_step: z.number().int().min(0).optional(),
  expect: z.enum(['url_matches', 'selector_present', 'selector_absent']),
  pattern: z.string().optional(),
  selector: z.string().optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const PlaybookVersionSchema = z
  .object({
    version: z.number().int().min(1),
    engine_min_version: z.string(),
    playbook_type: z.enum(['extraction', 'action']),
    output_format: z.record(z.string(), z.unknown()).nullable().optional(),
    required_data_keys: z.array(z.string()),
    steps: z.array(StepSchema).min(1),
    assertions: z.array(AssertionSchema).optional(),
  })
  .strict();
export type PlaybookVersion = z.infer<typeof PlaybookVersionSchema>;

/** Parse + validate a playbook body. Throws ZodError on a malformed body (never a best-effort run). */
export function parsePlaybookVersion(body: unknown): PlaybookVersion {
  return PlaybookVersionSchema.parse(body);
}
