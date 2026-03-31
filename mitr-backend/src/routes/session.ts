import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessToken, VideoGrant } from 'livekit-server-sdk';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { getRequiredLivekitConfig } from '../config/livekit-config.js';
import { SessionStore } from '../services/session-store.js';
import { ProfileService } from '../services/profile/profile-service.js';
import { latencyTracker } from '../services/latency-tracker.js';
import { redisLatencySnapshot } from '../services/latency-redis.js';
import { SessionDirectorService } from '../services/long-session/session-director-service.js';
import { longSessionMetrics } from '../services/long-session/long-session-metrics.js';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { logger } from '../lib/logger.js';
import { getApiHealthStatus } from '../services/health/health-status.js';

const sessionStartSchema = z.object({
  userId: z.string().min(1).optional()
});

const sessionEventsPullSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  afterEventId: z.string().uuid().optional()
});

const sessionEndSchema = z.object({
  sessionId: z.string().min(1)
});

const onboardingSubmitSchema = z.object({
  answers: z.record(z.string())
});

const livekitTokenSchema = z.object({
  userId: z.string().min(1).optional(),
  roomName: z.string().min(1).optional(),
  language: z.string().optional(),
  participantName: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

const longSessionStartSchema = z.object({
  userId: z.string().min(1).optional(),
  mode: z.enum(['companion_long', 'satsang_long', 'story_long']),
  targetDurationSec: z.number().int().min(300).max(7200).optional(),
  topic: z.string().optional(),
  language: z.string().optional(),
  resumeIfRunning: z.boolean().optional(),
  paceMode: z.enum(['interactive', 'continuous']).optional(),
  targetShlokaCount: z.number().int().min(2).max(8).optional()
});

const longSessionStopSchema = z.object({
  longSessionId: z.string().min(1),
  reason: z.string().optional()
});

const slug = (input: string): string => input.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'user';

const buildRoomName = (userId: string, roomName?: string): string => {
  if (roomName?.trim()) return roomName.trim();
  return `mitr-${slug(userId)}-${Date.now()}`;
};

export const registerSessionRoutes = (
  app: FastifyInstance,
  store: SessionStore,
  profiles: ProfileService,
  auth: AuthService
): void => {
  const director = new SessionDirectorService();
  const authGuard = requireAuth(auth);

  app.post('/session/start', { preHandler: authGuard }, async (request, reply) => {
    const parsed = sessionStartSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const userId = request.auth!.user.id;
    const profile = await profiles.getProfile(userId);
    const onboardingRequired = !(await profiles.hasCompletedOnboarding(userId));
    const sessionId = await store.create(userId, profile?.answers);
    const pendingEvents = await store.pullUserEvents(userId, 20);

    return reply.send({
      sessionId,
      transport: 'livekit',
      pendingEvents,
      onboarding: {
        required: onboardingRequired,
        questions: onboardingRequired ? profiles.getQuestions() : [],
        profile: profile?.answers ?? null
      }
    });
  });

  app.post('/session/end', { preHandler: authGuard }, async (request, reply) => {
    const parsed = sessionEndSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    await store.terminate(parsed.data.sessionId, 'client_end');
    return reply.send({ ok: true });
  });

  app.post('/session/events/pull', { preHandler: authGuard }, async (request, reply) => {
    const parsed = sessionEventsPullSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const events = await store.pullUserEvents(request.auth!.user.id, parsed.data.limit ?? 20, parsed.data.afterEventId);
    return reply.send({
      events,
      nextAfterEventId: events.length > 0 ? events[events.length - 1]?.id : parsed.data.afterEventId ?? null
    });
  });

  app.get('/events/stream', { preHandler: authGuard }, async (request, reply) => {
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).optional(),
        afterEventId: z.string().uuid().optional()
      })
      .safeParse(request.query ?? {});

    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const events = await store.streamUserEvents(request.auth!.user.id, {
      limit: parsed.data.limit ?? 20,
      afterEventId: parsed.data.afterEventId
    });
    return reply.send({
      events,
      nextAfterEventId: events.length > 0 ? events[events.length - 1]?.id : parsed.data.afterEventId ?? null
    });
  });

  app.post('/livekit/token', { preHandler: authGuard }, async (request, reply) => {
    const parsed = livekitTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const livekit = getRequiredLivekitConfig();
    if (!livekit) {
      return reply.status(500).send({
        error: 'LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.'
      });
    }

    const userId = request.auth!.user.id;
    const profile = await profiles.getProfile(userId);
    const roomName = buildRoomName(userId, parsed.data.roomName);
    const identity = parsed.data.participantName?.trim() || `user-${slug(userId)}-${Math.floor(Math.random() * 10_000)}`;

    const at = new AccessToken(livekit.apiKey, livekit.apiSecret, {
      identity,
      ttl: livekit.tokenTtlSec
    });

    const videoGrant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    };
    at.addGrant(videoGrant);

    const dispatchMetadata = {
      user_id: userId,
      language: parsed.data.language ?? profile?.answers?.language ?? 'hi-IN',
      profile_answers: profile?.answers ?? null,
      ...(parsed.data.metadata ?? {})
    };

    at.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName: livekit.agentName,
          metadata: JSON.stringify(dispatchMetadata)
        })
      ]
    });

    const participantToken = await at.toJwt();
    return reply.send({
      serverUrl: livekit.url,
      participantToken,
      roomName,
      identity,
      agentName: livekit.agentName
    });
  });

  app.get('/onboarding/questions', async (_request, reply) => {
    return reply.send({ questions: profiles.getQuestions() });
  });

  app.get('/onboarding/status', { preHandler: authGuard }, async (request, reply) => {
    const userId = request.auth!.user.id;
    const profile = await profiles.getProfile(userId);
    const completed = await profiles.hasCompletedOnboarding(userId);
    return reply.send({ completed, profile: profile?.answers ?? null });
  });

  app.post('/onboarding/submit', { preHandler: authGuard }, async (request, reply) => {
    const parsed = onboardingSubmitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const profile = await profiles.saveAnswers(request.auth!.user.id, parsed.data.answers);
    return reply.send({ ok: true, profile: profile.answers });
  });

  app.get('/healthz', async (request, reply) => {
    const health = await getApiHealthStatus();
    if (!health.ok) {
      logger.warn('API health degraded', {
        requestId: request.id,
        dependencies: health.dependencies
      });
    }
    return reply.status(health.ok ? 200 : 503).send({
      requestId: request.id,
      ...health
    });
  });

  app.get('/health/latency', async (_request, reply) => {
    const redisSnapshot = await redisLatencySnapshot();
    return reply.send({
      ok: true,
      snapshot: redisSnapshot.totalTurns > 0 ? redisSnapshot : latencyTracker.snapshot(),
      longSession: longSessionMetrics.snapshot()
    });
  });

  app.post('/long-session/start', { preHandler: authGuard }, async (request, reply) => {
    const parsed = longSessionStartSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const started = await director.start({
      ...parsed.data,
      userId: request.auth!.user.id
    });
    longSessionMetrics.recordStarted();
    return reply.send(started);
  });

  app.post('/long-session/next', { preHandler: authGuard }, async (request, reply) => {
    const parsed = z
      .object({
        longSessionId: z.string().min(1),
        blockId: z.string().optional(),
        blockState: z.enum(['done', 'skipped', 'failed']).optional(),
        result: z.record(z.unknown()).optional(),
        elapsedDeltaSec: z.number().int().min(0).max(600).optional(),
        autoRecover: z.boolean().optional()
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (parsed.data.blockId) {
      await director.completeBlock({
        longSessionId: parsed.data.longSessionId,
        blockId: parsed.data.blockId,
        state: parsed.data.blockState ?? 'done',
        result: parsed.data.result,
        elapsedDeltaSec: parsed.data.elapsedDeltaSec
      });
    }
    const nextBlock = await director.next(parsed.data.longSessionId);
    if (!nextBlock && parsed.data.autoRecover) {
      await director.enqueueRecoveryRecap(parsed.data.longSessionId, 'Chaliye pichli baat ko jod kar aage badhte hain.');
    }
    const recoveredNextBlock = !nextBlock && parsed.data.autoRecover ? await director.next(parsed.data.longSessionId) : nextBlock;
    const snapshot = await director.get(parsed.data.longSessionId);
    return reply.send({ session: snapshot, nextBlock: recoveredNextBlock });
  });

  app.post('/long-session/stop', { preHandler: authGuard }, async (request, reply) => {
    const parsed = longSessionStopSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const stopped = await director.stop(parsed.data.longSessionId, parsed.data.reason ?? 'http_stop');
    return reply.send({ session: stopped });
  });

  app.get('/long-session/:id', { preHandler: authGuard }, async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const details = await director.getDetailed(parsed.data.id);
    if (!details) return reply.status(404).send({ error: 'Not found' });
    return reply.send(details);
  });

  app.get('/long-session/:id/summary', { preHandler: authGuard }, async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const summaries = await director.listSummaries(parsed.data.id);
    return reply.send({ summaries });
  });
};
