import type { FastifyInstance } from 'fastify';
import type { PlaybookRepository } from '../../persistence/playbooks/repository';

/** Playbook admin surface (PROJECT_SPEC §4.1): list / contract / version / activate (rollback) / soft-delete. */
export function registerPlaybookRoutes(app: FastifyInstance, playbooks: PlaybookRepository): void {
  app.get<{ Querystring: { health?: string } }>('/v1/playbooks', async (req, reply) => {
    const list = await playbooks.list(req.query.health);
    return reply.code(200).send({ playbooks: list });
  });

  app.get<{ Params: { id: string } }>('/v1/playbooks/:id', async (req, reply) => {
    const contract = await playbooks.getContract(req.params.id);
    if (!contract) {
      return reply.code(404).send({ error: { code: 'playbook_not_found', message: 'playbook not found' } });
    }
    return reply.code(200).send(contract);
  });

  app.get<{ Params: { id: string; v: string } }>('/v1/playbooks/:id/versions/:v', async (req, reply) => {
    const version = Number(req.params.v);
    if (!Number.isInteger(version) || version < 1) {
      return reply.code(422).send({ error: { code: 'validation_error', message: 'invalid version' } });
    }
    const body = await playbooks.loadVersion(req.params.id, version);
    if (!body) {
      return reply.code(404).send({ error: { code: 'playbook_not_found', message: 'version not found' } });
    }
    return reply.code(200).send(body);
  });

  app.post<{ Params: { id: string }; Body: { version?: number } }>(
    '/v1/playbooks/:id/activate',
    async (req, reply) => {
      const version = req.body?.version;
      if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
        return reply.code(422).send({ error: { code: 'validation_error', message: 'version (positive integer) required' } });
      }
      const ok = await playbooks.activate(req.params.id, version);
      if (!ok) {
        return reply.code(404).send({ error: { code: 'playbook_not_found', message: 'playbook or version not found' } });
      }
      return reply.code(200).send({ playbook_id: req.params.id, active_version: version });
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/playbooks/:id', async (req, reply) => {
    const ok = await playbooks.softDelete(req.params.id);
    if (!ok) {
      return reply.code(404).send({ error: { code: 'playbook_not_found', message: 'playbook not found' } });
    }
    return reply.code(200).send({ playbook_id: req.params.id, deleted: true });
  });
}
