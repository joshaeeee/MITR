import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireInternalServiceAuth } from '../services/auth/internal-service-auth.js';
import { DeviceControlService } from '../services/device/device-control-service.js';
import { requireDeviceAuth } from '../services/device/device-auth.js';

const sessionParamsSchema = z.object({
  sessionId: z.string().uuid()
});

const conversationParamsSchema = z.object({
  conversationId: z.string().uuid()
});

const wakeDetectedSchema = z.object({
  bootId: z.string().min(8),
  wakeId: z.string().min(1).optional(),
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

const conversationUserActivitySchema = z.object({
  activityAtMs: z.number().int().optional()
});

const agentReadySchema = z.object({
  bootId: z.string().min(8),
  agentJobId: z.string().optional(),
  participantIdentity: z.string().optional(),
  readyAtMs: z.number().int().optional()
}).passthrough();

const agentErrorSchema = z.object({
  bootId: z.string().min(8),
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

  app.post('/internal/device-sessions/:sessionId/agent-ready', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    const body = agentReadySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const session = await control.markAgentReady(params.data.sessionId, body.data.bootId, body.data);
    if (!session) return reply.status(404).send({ error: 'Device session not found' });
    return reply.send({ ok: true, session });
  });

  app.post('/internal/device-sessions/:sessionId/agent-error', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const params = sessionParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    const body = agentErrorSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const session = await control.markAgentFailed(params.data.sessionId, body.data.bootId, body.data.reason);
    if (!session) return reply.status(404).send({ error: 'Device session not found' });
    return reply.send({ ok: true, session });
  });

  app.post('/internal/device-conversations/:conversationId/conversation-active', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const params = conversationParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });

    const conversation = await control.markConversationActive(params.data.conversationId);
    if (!conversation) return reply.status(404).send({ error: 'Device conversation not found' });
    return reply.send({ ok: true, conversation });
  });

  app.post('/internal/device-conversations/:conversationId/user-activity', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const params = conversationParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    const body = conversationUserActivitySchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const activityAt = typeof body.data.activityAtMs === 'number' ? new Date(body.data.activityAtMs) : new Date();
    const conversation = await control.markConversationUserActivity(params.data.conversationId, activityAt);
    if (!conversation) return reply.status(404).send({ error: 'Device conversation not found' });
    return reply.send({ ok: true, conversation });
  });

  app.post('/internal/device-conversations/:conversationId/conversation-ended', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const params = conversationParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    const body = conversationEndedSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const conversation = await control.markConversationEnded(params.data.conversationId, body.data.reason);
    if (!conversation) return reply.status(404).send({ error: 'Device conversation not found' });
    return reply.send({ ok: true, conversation });
  });

  app.post('/internal/device-conversations/:conversationId/conversation-error', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const params = conversationParamsSchema.safeParse(request.params ?? {});
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    const body = conversationErrorSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });

    const conversation = await control.markConversationError(params.data.conversationId, body.data.reason);
    if (!conversation) return reply.status(404).send({ error: 'Device conversation not found' });
    return reply.send({ ok: true, conversation });
  });
};
