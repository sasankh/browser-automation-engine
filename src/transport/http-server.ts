import Fastify from 'fastify';
import type { FastifyInstance, FastifyError } from 'fastify';
import type { Db } from '../persistence/db';
import type { RunOrchestrator } from '../orchestrator/run-orchestrator';
import type { PlaybookRepository } from '../persistence/playbooks/repository';
import type { EvidenceStore } from '../persistence/evidence/evidence';
import type { Lifecycle } from '../orchestrator/lifecycle';
import { registerRunRoutes } from './routes/runs';
import { registerHealthRoutes } from './routes/health';
import { registerPlaybookRoutes } from './routes/playbooks';
import { loggerOptions } from '../shared/logger';

export interface ServerDeps {
  db: Db;
  orchestrator: RunOrchestrator;
  playbooks: PlaybookRepository;
  evidence: EvidenceStore;
  lifecycle: Lifecycle;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: loggerOptions });

  // The engine never throws past the service boundary (EXECUTION_STANDARDS §3): malformed input
  // becomes `validation_error`, anything unexpected becomes `internal_error` — never a raw stack.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const badRequest =
      err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      err.validation !== undefined ||
      err.statusCode === 400;
    if (badRequest) {
      return reply.code(err.statusCode ?? 400).send({
        error: { code: 'validation_error', message: err.message },
      });
    }
    app.log.error({ err }, 'unhandled request error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'internal error' } });
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.code(404).send({ error: { message: 'not found' } });
  });

  registerRunRoutes(app, deps.orchestrator, deps.evidence);
  registerHealthRoutes(app, deps.db, deps.lifecycle);
  registerPlaybookRoutes(app, deps.playbooks);
  return app;
}
