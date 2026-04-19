import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalServiceAuth } from '../services/auth/internal-service-auth.js';
import { DeviceControlService } from '../services/device/device-control-service.js';
import { requireDeviceAuth } from '../services/device/device-auth.js';

const sessionParamsSchema = z.object({
  sessionId: z.string().uuid()
});

const wakeDetectedSchema = z.object({
  modelName: z.string().min(1),
  phrase: z.string().min(1),
  score: z.number(),
  detectedAtMs: z.number().int()
});

const conversationEndedSchema = z.object({
  reason: z.string().min(1)
});

const conversationErrorSchema = z.object({
  reason: z.string().min(1)
});

export const registerInternalDeviceSessionRoutes = (app: FastifyInstance): void => {
  const control = new DeviceControlService();
  const deviceGuard = requireDeviceAuth(control);

  const requireInternalOrDeviceAuth = async (request: Parameters<typeof requireInternalServiceAuth>[0], reply: Parameters<typeof requireInternalServiceAuth>[1]) => {
    const internalToken = request.headers['x-internal-service-token'];
    if (typeof internalToken === 'string' && internalToken.trim().length > 0) {
      await requireInternalServiceAuth(request, reply);
      return;
    }
    await deviceGuard(request, reply);
  };

  app.get('/internal/device-sessions/active', { preHandler: requireInternalServiceAuth }, async (_request, reply) => {
    return reply.send({ items: await control.listLiveDeviceSessions() });
  });

  app.get('/internal/device-sessions/:sessionId', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });

    const session = await control.getDeviceSession(params.data.sessionId);
    if (!session) return reply.status(404).send({ error: 'Device session not found' });
    return reply.send(session);
  });

  app.post('/internal/device-sessions/:sessionId/wake-detected', { preHandler: requireInternalOrDeviceAuth }, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    const body = wakeDetectedSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    if (request.deviceAuth) {
      const session = await control.getDeviceSession(params.data.sessionId);
      if (!session) return reply.status(404).send({ error: 'Device session not found' });
      if (session.deviceId !== request.deviceAuth.device.deviceId) {
        return reply.status(403).send({ error: 'Session does not belong to authenticated device' });
      }
    }

    try {
      const result = await control.handleWakeDetected({
        sessionId: params.data.sessionId,
        ...body.data
      });
      return reply.send(result);
    } catch (error) {
      return reply.status(500).send({ error: (error as Error).message });
    }
  });

  app.post('/internal/device-sessions/:sessionId/conversation-active', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });

    const session = await control.markConversationActive(params.data.sessionId);
    if (!session) return reply.status(404).send({ error: 'Device session not found' });
    return reply.send({ ok: true, session });
  });

  app.post('/internal/device-sessions/:sessionId/conversation-ended', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    const body = conversationEndedSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const session = await control.markConversationEnded(params.data.sessionId, body.data.reason);
    if (!session) return reply.status(404).send({ error: 'Device session not found' });
    return reply.send({ ok: true, session });
  });

  app.post('/internal/device-sessions/:sessionId/conversation-error', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    const body = conversationErrorSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const session = await control.markConversationError(params.data.sessionId, body.data.reason);
    if (!session) return reply.status(404).send({ error: 'Device session not found' });
    return reply.send({ ok: true, session });
  });
};
