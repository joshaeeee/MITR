import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AccessToken, VideoGrant } from 'livekit-server-sdk';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { env } from '../config/env.js';
import { SessionStore } from '../services/session-store.js';
import { ProfileService } from '../services/profile/profile-service.js';
import { latencyTracker } from '../services/latency-tracker.js';
import { SessionDirectorService } from '../services/long-session/session-director-service.js';
import { longSessionMetrics } from '../services/long-session/long-session-metrics.js';

const sessionStartSchema = z.object({
  userId: z.string().min(1)
});

const sessionEventsPullSchema = z.object({
  userId: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional()
});

const sessionEndSchema = z.object({
  sessionId: z.string().min(1)
});

const onboardingSubmitSchema = z.object({
  userId: z.string().min(1),
  answers: z.record(z.string())
});

const livekitTokenSchema = z.object({
  userId: z.string().min(1),
  roomName: z.string().min(1).optional(),
  language: z.string().optional(),
  participantName: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

const longSessionStartSchema = z.object({
  userId: z.string().min(1),
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

export const registerSessionRoutes = (app: FastifyInstance, store: SessionStore, profiles: ProfileService): void => {
  const director = new SessionDirectorService();

  app.post('/session/start', async (request, reply) => {
    const parsed = sessionStartSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const profile = await profiles.getProfile(parsed.data.userId);
    const onboardingRequired = !(await profiles.hasCompletedOnboarding(parsed.data.userId));
    const sessionId = await store.create(parsed.data.userId, profile?.answers);
    const pendingEvents = await store.pullUserEvents(parsed.data.userId, 20);

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

  app.post('/session/end', async (request, reply) => {
    const parsed = sessionEndSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    await store.terminate(parsed.data.sessionId, 'client_end');
    return reply.send({ ok: true });
  });

  app.post('/session/events/pull', async (request, reply) => {
    const parsed = sessionEventsPullSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const events = await store.pullUserEvents(parsed.data.userId, parsed.data.limit ?? 20);
    return reply.send({ events });
  });

  app.post('/livekit/token', async (request, reply) => {
    const parsed = livekitTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
      return reply.status(500).send({
        error: 'LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.'
      });
    }

    const userId = parsed.data.userId;
    const profile = await profiles.getProfile(userId);
    const roomName = buildRoomName(userId, parsed.data.roomName);
    const identity = parsed.data.participantName?.trim() || `user-${slug(userId)}-${Math.floor(Math.random() * 10_000)}`;

    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity,
      ttl: env.LIVEKIT_TOKEN_TTL_SEC
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
          agentName: env.LIVEKIT_AGENT_NAME,
          metadata: JSON.stringify(dispatchMetadata)
        })
      ]
    });

    const participantToken = await at.toJwt();
    return reply.send({
      serverUrl: env.LIVEKIT_URL,
      participantToken,
      roomName,
      identity,
      agentName: env.LIVEKIT_AGENT_NAME
    });
  });

  app.get('/onboarding/questions', async (_request, reply) => {
    return reply.send({ questions: profiles.getQuestions() });
  });

  app.get('/onboarding/status', async (request, reply) => {
    const query = z.object({ userId: z.string().min(1) }).safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.flatten() });
    }

    const profile = await profiles.getProfile(query.data.userId);
    const completed = await profiles.hasCompletedOnboarding(query.data.userId);
    return reply.send({ completed, profile: profile?.answers ?? null });
  });

  app.post('/onboarding/submit', async (request, reply) => {
    const parsed = onboardingSubmitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const profile = await profiles.saveAnswers(parsed.data.userId, parsed.data.answers);
    return reply.send({ ok: true, profile: profile.answers });
  });

  app.get('/healthz', async (_request, reply) => {
    return reply.send({ ok: true, service: 'mitr-api' });
  });

  app.get('/health/latency', async (_request, reply) => {
    return reply.send({
      ok: true,
      snapshot: latencyTracker.snapshot(),
      longSession: longSessionMetrics.snapshot()
    });
  });

  app.post('/long-session/start', async (request, reply) => {
    const parsed = longSessionStartSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const started = await director.start(parsed.data);
    longSessionMetrics.recordStarted();
    return reply.send(started);
  });

  app.post('/long-session/next', async (request, reply) => {
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

  app.post('/long-session/stop', async (request, reply) => {
    const parsed = longSessionStopSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const stopped = await director.stop(parsed.data.longSessionId, parsed.data.reason ?? 'http_stop');
    return reply.send({ session: stopped });
  });

  app.get('/long-session/:id', async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const details = await director.getDetailed(parsed.data.id);
    if (!details) return reply.status(404).send({ error: 'Not found' });
    return reply.send(details);
  });

  app.get('/long-session/:id/summary', async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const summaries = await director.listSummaries(parsed.data.id);
    return reply.send({ summaries });
  });
};
