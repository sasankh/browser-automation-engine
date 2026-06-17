import type { FastifyInstance } from 'fastify';
import type { RunOrchestrator } from '../../orchestrator/run-orchestrator';
import type { EvidenceStore } from '../../persistence/evidence/evidence';
import { PayloadSchema } from '../../intake/payload-schema';

export function registerRunRoutes(
  app: FastifyInstance,
  orchestrator: RunOrchestrator,
  evidence: EvidenceStore,
): void {
  app.post('/v1/runs', async (req, reply) => {
    const parsed = PayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(422).send({ error: { code: 'validation_error', message } });
    }
    const result = await orchestrator.submit(parsed.data);
    if (result.kind === 'rejected') {
      return reply.code(result.http).send({ error: { code: result.code, message: result.message } });
    }
    return reply.code(202).send({ meta: { run_id: result.run_id, status: 'queued' } });
  });

  app.get<{ Params: { id: string } }>('/v1/runs/:id', async (req, reply) => {
    const envelope = await orchestrator.getEnvelope(req.params.id);
    if (!envelope) return reply.code(404).send({ error: { message: 'run not found' } });
    return reply.code(200).send(envelope);
  });

  app.get<{ Params: { id: string; file: string } }>(
    '/v1/runs/:id/evidence/:file',
    async (req, reply) => {
      const buf = await evidence.readFile(req.params.id, req.params.file);
      if (!buf) return reply.code(404).send({ error: { message: 'evidence not found' } });
      const contentType = req.params.file.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
      return reply.code(200).header('content-type', contentType).send(buf);
    },
  );
}
