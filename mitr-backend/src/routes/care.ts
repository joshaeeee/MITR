import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { CareService } from '../services/care/care-service.js';

const careSectionSchema = z.enum(['medicines', 'repeated_reminders', 'one_off_plans', 'important_dates']);
const careTypeSchema = z.enum(['medicine', 'reminder', 'plan', 'date']);

const reminderCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  scheduledTime: z.string().min(1),
  enabled: z.boolean().optional()
});

const reminderPatchSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  scheduledTime: z.string().min(1).optional(),
  enabled: z.boolean().optional()
});

const reminderParamSchema = z.object({
  id: z.string().min(1)
});

const routinePatchSchema = z.object({
  title: z.string().optional(),
  enabled: z.boolean().optional(),
  schedule: z.string().optional()
});

const carePlanSectionSchema = z.enum([
  'medicines',
  'repeated_reminders',
  'one_off_plans',
  'important_dates'
]);

const carePlanTypeSchema = z.enum(['medicine', 'reminder', 'plan', 'date']);

const careItemCreateSchema = z.object({
  section: carePlanSectionSchema,
  type: carePlanTypeSchema.optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  scheduledAt: z.string().optional(),
  repeatRule: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().optional()
});

const careItemPatchSchema = z.object({
  section: carePlanSectionSchema.optional(),
  type: carePlanTypeSchema.optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  scheduledAt: z.string().optional(),
  repeatRule: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.number().int().optional()
});

const careItemParamSchema = z.object({
  id: z.string().min(1)
});

export const registerCareRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const care = new CareService();
  const guard = requireAuth(auth);

  app.get('/care/reminders', { preHandler: guard }, async (request, reply) => {
    return reply.send({ items: await care.listReminders(request.auth!.user.id) });
  });

  app.get('/care/items', { preHandler: guard }, async (request, reply) => {
    return reply.send({ items: await care.listItems(request.auth!.user.id) });
  });

  app.post('/care/items', { preHandler: guard }, async (request, reply) => {
    const parsed = careItemCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await care.createItem(request.auth!.user.id, parsed.data));
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.patch('/care/items/:id', { preHandler: guard }, async (request, reply) => {
    const params = careItemParamSchema.safeParse(request.params);
    const body = careItemPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        error: {
          params: params.success ? null : params.error.flatten(),
          body: body.success ? null : body.error.flatten()
        }
      });
    }
    try {
      const updated = await care.patchItem(request.auth!.user.id, params.data.id, body.data);
      if (!updated) return reply.status(404).send({ error: 'Care item not found' });
      return reply.send(updated);
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.delete('/care/items/:id', { preHandler: guard }, async (request, reply) => {
    const params = careItemParamSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    try {
      const ok = await care.deleteItem(request.auth!.user.id, params.data.id);
      return reply.send({ ok });
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.post('/care/reminders', { preHandler: guard }, async (request, reply) => {
    const parsed = reminderCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await care.createReminder(request.auth!.user.id, parsed.data));
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.patch('/care/reminders/:id', { preHandler: guard }, async (request, reply) => {
    const params = reminderParamSchema.safeParse(request.params);
    const body = reminderPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        error: {
          params: params.success ? null : params.error.flatten(),
          body: body.success ? null : body.error.flatten()
        }
      });
    }
    try {
      const updated = await care.patchReminder(request.auth!.user.id, params.data.id, body.data);
      if (!updated) return reply.status(404).send({ error: 'Reminder not found' });
      return reply.send(updated);
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.delete('/care/reminders/:id', { preHandler: guard }, async (request, reply) => {
    const params = reminderParamSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    try {
      const ok = await care.deleteReminder(request.auth!.user.id, params.data.id);
      return reply.send({ ok });
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.get('/care/routines', { preHandler: guard }, async (request, reply) => {
    return reply.send({ items: await care.listRoutines(request.auth!.user.id) });
  });

  app.patch('/care/routines/:id', { preHandler: guard }, async (request, reply) => {
    const params = reminderParamSchema.safeParse(request.params);
    const body = routinePatchSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        error: {
          params: params.success ? null : params.error.flatten(),
          body: body.success ? null : body.error.flatten()
        }
      });
    }
    try {
      const updated = await care.patchRoutine(request.auth!.user.id, params.data.id, body.data);
      if (!updated) return reply.status(404).send({ error: 'Routine not found' });
      return reply.send(updated);
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });
};
