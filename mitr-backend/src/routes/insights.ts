import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { InsightsService } from '../services/insights/insights-service.js';

const timelineQuerySchema = z.object({
  range: z.enum(['24h', '7d', '30d']).default('7d')
});

const topicsQuerySchema = z.object({
  range: z.enum(['7d', '30d']).default('7d')
});

const concernsQuerySchema = z.object({
  status: z.enum(['open', 'all']).default('open')
});

const sessionsQuerySchema = z.object({
  cursor: z.string().optional()
});

const explanationsQuerySchema = z.object({
  signalId: z.string().min(1)
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const dailyDigestQuerySchema = z.object({
  date: dateSchema
});

const dailyRangeQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema
});

const recommendationIdParamsSchema = z.object({
  id: z.string().min(1)
});

const recommendationFeedbackBodySchema = z.object({
  action: z.enum(['accepted', 'dismissed', 'completed']),
  notes: z.string().max(1200).optional()
});

const recommendationConfirmBodySchema = z.object({
  confirmed: z.boolean()
});

const checkinBodySchema = z.discriminatedUnion('period', [
  z.object({
    period: z.literal('day'),
    matched: z.boolean(),
    concernLevel: z.enum(['none', 'low', 'medium', 'high']).optional(),
    notes: z.string().max(1200).optional(),
    weekStartDate: dateSchema.optional()
  }),
  z.object({
    period: z.literal('week'),
    moodLabel: z.enum(['better', 'same', 'worse']),
    engagementLabel: z.enum(['better', 'same', 'worse']),
    socialLabel: z.enum(['better', 'same', 'worse']),
    concernLevel: z.enum(['none', 'low', 'medium', 'high']).optional(),
    notes: z.string().max(1200).optional(),
    weekStartDate: dateSchema.optional()
  })
]);

const legacyWeeklyCheckinBodySchema = z.object({
  moodLabel: z.enum(['better', 'same', 'worse']),
  engagementLabel: z.enum(['better', 'same', 'worse']),
  socialLabel: z.enum(['better', 'same', 'worse']),
  concernLevel: z.enum(['none', 'low', 'medium', 'high']).optional(),
  notes: z.string().max(1200).optional(),
  weekStartDate: dateSchema.optional()
});

export const registerInsightsRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const insights = new InsightsService();
  const guard = requireAuth(auth);

  app.get('/insights/overview', { preHandler: guard }, async (request, reply) => {
    return reply.send(await insights.overview(request.auth!.user.id));
  });

  app.get('/insights/timeline', { preHandler: guard }, async (request, reply) => {
    const parsed = timelineQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return reply.send(await insights.timeline(request.auth!.user.id, parsed.data.range));
  });

  app.get('/insights/topics', { preHandler: guard }, async (request, reply) => {
    const parsed = topicsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return reply.send(await insights.topics(request.auth!.user.id, parsed.data.range));
  });

  app.get('/insights/concerns', { preHandler: guard }, async (request, reply) => {
    const parsed = concernsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return reply.send({ items: await insights.concerns(request.auth!.user.id, parsed.data.status) });
  });

  app.get('/insights/sessions', { preHandler: guard }, async (request, reply) => {
    const parsed = sessionsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return reply.send(await insights.sessions(request.auth!.user.id, parsed.data.cursor));
  });

  app.get('/insights/explanations', { preHandler: guard }, async (request, reply) => {
    const parsed = explanationsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return reply.send(await insights.explanations(request.auth!.user.id, parsed.data.signalId));
  });

  app.post('/insights/checkin', { preHandler: guard }, async (request, reply) => {
    const parsed = checkinBodySchema.safeParse(request.body);
    if (parsed.success) {
      return reply.send(await insights.checkin(request.auth!.user.id, parsed.data));
    }

    const legacy = legacyWeeklyCheckinBodySchema.safeParse(request.body);
    if (!legacy.success) return reply.status(400).send({ error: parsed.error.flatten() });

    return reply.send(
      await insights.checkin(request.auth!.user.id, {
        period: 'week',
        moodLabel: legacy.data.moodLabel,
        engagementLabel: legacy.data.engagementLabel,
        socialLabel: legacy.data.socialLabel,
        concernLevel: legacy.data.concernLevel,
        notes: legacy.data.notes,
        weekStartDate: legacy.data.weekStartDate
      })
    );
  });

  app.get('/insights/pipeline/health', { preHandler: guard }, async (request, reply) => {
    return reply.send(await insights.pipelineHealth(request.auth!.user.id));
  });

  app.get('/insights/digest/today', { preHandler: guard }, async (request, reply) => {
    return reply.send(await insights.dailyDigestToday(request.auth!.user.id));
  });

  app.get('/insights/daily', { preHandler: guard }, async (request, reply) => {
    const parsed = dailyDigestQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return reply.send(await insights.dailyDigestByDate(request.auth!.user.id, parsed.data.date));
  });

  app.get('/insights/daily/range', { preHandler: guard }, async (request, reply) => {
    const parsed = dailyRangeQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    if (parsed.data.from > parsed.data.to) {
      return reply.status(400).send({ error: 'Invalid range: from must be <= to' });
    }
    return reply.send(await insights.dailyDigestRange(request.auth!.user.id, parsed.data.from, parsed.data.to));
  });

  app.get('/insights/recommendations/active', { preHandler: guard }, async (request, reply) => {
    return reply.send({ items: await insights.activeRecommendations(request.auth!.user.id) });
  });

  app.post('/insights/recommendations/:id/feedback', { preHandler: guard }, async (request, reply) => {
    const params = recommendationIdParamsSchema.safeParse(request.params);
    const body = recommendationFeedbackBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten()
        }
      });
    }

    return reply.send(
      await insights.submitRecommendationFeedback(
        request.auth!.user.id,
        params.data.id,
        body.data.action,
        body.data.notes
      )
    );
  });

  app.patch('/insights/recommendations/:id/confirm-action', { preHandler: guard }, async (request, reply) => {
    const params = recommendationIdParamsSchema.safeParse(request.params);
    const body = recommendationConfirmBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        error: {
          params: params.success ? undefined : params.error.flatten(),
          body: body.success ? undefined : body.error.flatten()
        }
      });
    }

    return reply.send(
      await insights.confirmRecommendationAction(request.auth!.user.id, params.data.id, body.data.confirmed)
    );
  });
};
