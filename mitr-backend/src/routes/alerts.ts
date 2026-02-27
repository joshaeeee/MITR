import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { AlertsService } from '../services/alerts/alerts-service.js';
import { getFamilyRepository } from '../services/family/family-repository.js';

const alertParamSchema = z.object({
  id: z.string().min(1)
});

const policyPatchSchema = z.object({
  quietHoursStart: z.string().optional(),
  quietHoursEnd: z.string().optional(),
  stage1NudgeDelayMin: z.number().int().min(1).max(1440).optional(),
  stage2FamilyAlertDelayMin: z.number().int().min(1).max(2880).optional(),
  stage3EmergencyDelayMin: z.number().int().min(1).max(10080).optional(),
  enabledTriggers: z.array(z.enum(['missed_reminder', 'distress_language', 'inactivity', 'device_offline'])).optional()
});

export const registerAlertsRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const alerts = new AlertsService();
  const repo = getFamilyRepository();
  const guard = requireAuth(auth);

  app.get('/alerts', { preHandler: guard }, async (request, reply) => {
    return reply.send({ items: await alerts.list(request.auth!.user.id) });
  });

  app.get('/alerts/:id', { preHandler: guard }, async (request, reply) => {
    const parsed = alertParamSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const alert = await alerts.getById(request.auth!.user.id, parsed.data.id);
    if (!alert) return reply.status(404).send({ error: 'Alert not found' });
    return reply.send(alert);
  });

  app.post('/alerts/:id/ack', { preHandler: guard }, async (request, reply) => {
    const parsed = alertParamSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const updated = await alerts.acknowledge(request.auth!.user.id, parsed.data.id);
    if (!updated) return reply.status(404).send({ error: 'Alert not found' });
    return reply.send(updated);
  });

  app.post('/alerts/:id/resolve', { preHandler: guard }, async (request, reply) => {
    const parsed = alertParamSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const updated = await alerts.resolve(request.auth!.user.id, parsed.data.id);
    if (!updated) return reply.status(404).send({ error: 'Alert not found' });
    return reply.send(updated);
  });

  app.get('/escalation/policy', { preHandler: guard }, async (request, reply) => {
    try {
      return reply.send(await repo.getOrCreatePolicy(request.auth!.user.id));
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.patch('/escalation/policy', { preHandler: guard }, async (request, reply) => {
    const parsed = policyPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await repo.updatePolicy(request.auth!.user.id, parsed.data));
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });
};
