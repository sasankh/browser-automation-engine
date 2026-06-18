import { z } from 'zod';

/** Per-run behavior overrides a caller may set (PROJECT_SPEC §10, overridable subset only). */
export const PayloadConfigSchema = z
  .object({
    playbook_self_heal: z.boolean().optional(),
    self_heal_on_extraction_failure: z.boolean().optional(),
    run_timeout_seconds: z.number().int().positive().optional(),
    agent_max_steps: z.number().int().positive().optional(),
    model: z.string().min(1).optional(),
    evidence_capture: z.boolean().optional(),
    evidence_inline: z.boolean().optional(),
    proxy_enabled: z.boolean().optional(),
    headless: z.boolean().optional(),
    allow_offsite: z.boolean().optional(),
    replay_llm_fallback: z.enum(['on', 'off']).optional(),
    replay_llm_fallback_model: z.string().min(1).optional(),
    force_relearn: z.boolean().optional(),
  })
  // Unknown keys (e.g. a payload trying to set an env-only capacity key) are dropped, not
  // rejected — and surfaced at debug by the resolver (checklist: "ignored and logged at debug").
  .optional();

export type PayloadConfig = z.infer<typeof PayloadConfigSchema>;

const DataValue = z.union([z.string(), z.number(), z.boolean()]);

/** Request payload — identical for HTTP and SQS (PROJECT_SPEC §5). */
export const PayloadSchema = z
  .object({
    instruction: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    output_format: z.record(z.string(), z.unknown()).optional(),
    playbook_id: z.string().min(1).optional(),
    playbook_version: z.number().int().positive().optional(),
    data: z.record(z.string(), DataValue).optional(),
    config: PayloadConfigSchema,
    callback_url: z.string().min(1).optional(),
    idempotency_key: z.string().min(1).optional(),
  })
  // Resolution precondition (PROJECT_SPEC §5.3): playbook_id OR (instruction + url).
  .refine((p) => p.playbook_id !== undefined || (p.instruction !== undefined && p.url !== undefined), {
    message: 'Provide either playbook_id, or both instruction and url',
    path: ['instruction'],
  });

export type Payload = z.infer<typeof PayloadSchema>;
