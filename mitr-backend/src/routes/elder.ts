import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ElderService } from '../services/elder/elder-service.js';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';

const elderProfilePatchSchema = z.object({
  name: z.string().min(1),
  ageRange: z.string().optional(),
  language: z.string().optional(),
  city: z.string().optional(),
  timezone: z.string().optional()
});

const linkDeviceSchema = z.object({
  serialNumber: z.string().min(1),
  firmwareVersion: z.string().optional()
});

export const registerElderRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const elder = new ElderService();
  const guard = requireAuth(auth);

  app.get('/elder/profile', { preHandler: guard }, async (request, reply) => {
    return reply.send({ profile: await elder.getProfile(request.auth!.user.id) });
  });

  app.patch('/elder/profile', { preHandler: guard }, async (request, reply) => {
    const parsed = elderProfilePatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const profile = await elder.upsertProfile(request.auth!.user.id, parsed.data);
      return reply.send({ profile });
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.get('/elder/device/status', { preHandler: guard }, async (request, reply) => {
    return reply.send(await elder.getDeviceStatus(request.auth!.user.id));
  });

  app.post('/elder/device/link', { preHandler: guard }, async (request, reply) => {
    const parsed = linkDeviceSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await elder.linkDevice(request.auth!.user.id, parsed.data));
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.post('/elder/device/unlink', { preHandler: guard }, async (request, reply) => {
    try {
      const ok = await elder.unlinkDevice(request.auth!.user.id);
      return reply.send({ ok });
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });
};
