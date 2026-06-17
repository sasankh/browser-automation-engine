import type { FastifyInstance } from 'fastify';
import type { RunOrchestrator } from '../../orchestrator/run-orchestrator';
import { PayloadSchema } from '../../intake/payload-schema';

export function registerRunRoutes(app: FastifyInstance, orchestrator: RunOrchestrator): void {
  app.post('/v1/runs', async (req, reply) => {
    const parsed = PayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return reply.code(422).send({ error: { code: 'validation_error', message } });
    }
    const { run_id, status } = await orchestrator.submit(parsed.data);
    return reply.code(202).send({ meta: { run_id, status } });
  });

  app.get<{ Params: { id: string } }>('/v1/runs/:id', async (req, reply) => {
    const envelope = await orchestrator.getEnvelope(req.params.id);
    if (!envelope) return reply.code(404).send({ error: { message: 'run not found' } });
    return reply.code(200).send(envelope);
  });
}
