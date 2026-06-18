import { pino } from 'pino';
import type { LoggerOptions } from 'pino';

/**
 * Shared pino options — structured JSON, run_id-scoped, with `data` redacted (sensitive by default,
 * PROJECT_SPEC §13). Used both for the standalone logger and Fastify's request logger so config
 * stays in one place. The full Redactor lands in Phase 7; this is baseline log hygiene.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['data', '*.data', 'payload.data', 'req.body.data', 'config.data'],
    censor: '[redacted]',
  },
};

export const logger = pino(loggerOptions);

export type Logger = typeof logger;

export function runLogger(runId: string): Logger {
  return logger.child({ run_id: runId });
}
