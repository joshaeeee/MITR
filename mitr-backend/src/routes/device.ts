import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { DeviceService } from '../services/device/device-service.js';

const linkSchema = z.object({
  serialNumber: z.string().min(1),
  firmwareVersion: z.string().optional()
});

export const registerDeviceRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const device = new DeviceService();
  const guard = requireAuth(auth);

  app.get('/device/status', { preHandler: guard }, async (request, reply) => {
    return reply.send(await device.status(request.auth!.user.id));
  });

  app.post('/device/link', { preHandler: guard }, async (request, reply) => {
    const parsed = linkSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await device.link(request.auth!.user.id, parsed.data));
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.post('/device/unlink', { preHandler: guard }, async (request, reply) => {
    try {
      return reply.send({ ok: await device.unlink(request.auth!.user.id) });
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });
};
