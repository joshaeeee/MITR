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

const checkinBodySchema = z.object({
  moodLabel: z.enum(['better', 'same', 'worse']),
  engagementLabel: z.enum(['better', 'same', 'worse']),
  socialLabel: z.enum(['better', 'same', 'worse']),
  concernLevel: z.enum(['none', 'low', 'medium', 'high']).optional(),
  notes: z.string().max(1200).optional(),
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
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
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return reply.send(await insights.checkin(request.auth!.user.id, parsed.data));
  });

  app.get('/insights/pipeline/health', { preHandler: guard }, async (request, reply) => {
    return reply.send(await insights.pipelineHealth(request.auth!.user.id));
  });
};
