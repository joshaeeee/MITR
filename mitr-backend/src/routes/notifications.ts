import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { DigestNotifierService } from '../services/notifications/digest-notifier-service.js';

const preferencesPatchSchema = z.object({
  digestEnabled: z.boolean().optional(),
  digestHourLocal: z.number().int().min(0).max(23).optional(),
  digestMinuteLocal: z.number().int().min(0).max(59).optional(),
  timezone: z.string().min(1).max(80).optional(),
  realtimeEnabled: z.boolean().optional()
});

const pushTokenSchema = z.object({
  expoPushToken: z.string().min(1),
  platform: z.enum(['ios', 'android', 'unknown']).optional()
});

const isValidTimeZone = (value: string): boolean => {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

export const registerNotificationsRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const guard = requireAuth(auth);
  const notifier = new DigestNotifierService();

  app.get('/notifications/preferences', { preHandler: guard }, async (request, reply) => {
    return reply.send(await notifier.getOrCreatePreferences(request.auth!.user.id));
  });

  app.patch('/notifications/preferences', { preHandler: guard }, async (request, reply) => {
    const parsed = preferencesPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    if (parsed.data.timezone && !isValidTimeZone(parsed.data.timezone)) {
      return reply.status(400).send({ error: 'Invalid timezone' });
    }

    return reply.send(await notifier.updatePreferences(request.auth!.user.id, parsed.data));
  });

  app.post('/notifications/push-token', { preHandler: guard }, async (request, reply) => {
    const parsed = pushTokenSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return reply.send(
      await notifier.registerPushToken({
        userId: request.auth!.user.id,
        expoPushToken: parsed.data.expoPushToken,
        platform: parsed.data.platform
      })
    );
  });
};

