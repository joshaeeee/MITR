import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { conversationTurns } from '../db/schema.js';
import { requireAuth } from '../services/auth/auth-middleware.js';
import { requireInternalServiceAuth } from '../services/auth/internal-service-auth.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { Mem0Service } from '../services/memory/mem0-service.js';
import { ReminderService } from '../services/reminders/reminder-service.js';
import { CareService } from '../services/care/care-service.js';
import { NudgesService } from '../services/nudges/nudges-service.js';
import { ReligiousRetriever } from '../services/retrieval/religious-retriever.js';
import { NewsService } from '../services/news/news-service.js';
import { CompanionService } from '../services/companion/companion-service.js';
import { DiaryService } from '../services/companion/diary-service.js';
import { YoutubeStreamService } from '../services/media/youtube-stream-service.js';
import { SessionDirectorService } from '../services/long-session/session-director-service.js';
import { PanchangService } from '../services/panchang/panchang-service.js';
import { GeocodingService } from '../services/location/geocoding-service.js';
import { WebSearchService } from '../services/web/web-search-service.js';
import { createToolDefinitions } from '../services/agent/tools.js';
import { DeviceControlService } from '../services/device/device-control-service.js';
import { ElderJourneyService } from '../services/elder-journey/elder-journey-service.js';
import { ElderContextService } from '../services/memory/elder-context-service.js';

const cursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional()
});

const memoryQuerySchema = z.object({
  query: z.string().min(1),
  k: z.coerce.number().int().min(1).max(20).optional()
});

const tasksQuerySchema = z.object({
  status: z.enum(['pending', 'done', 'all']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

const internalToolInvokeSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.unknown()).optional(),
  context: z.object({
    userId: z.string().min(1),
    deviceId: z.string().min(1).optional(),
    familyId: z.preprocess((value) => value ?? undefined, z.string().uuid().optional()),
    elderId: z.preprocess((value) => value ?? undefined, z.string().uuid().optional()),
    language: z.string().optional(),
    sessionId: z.string().optional(),
    lastUserTranscript: z.string().optional()
  })
});

const pipecatNewsRetrieveArgsSchema = z.object({
  query: z.string().min(1),
  freshness: z.enum(['latest', 'recent', 'general']).nullish(),
  language: z.string().nullish(),
  regionCode: z.string().nullish(),
  stateOrCity: z.string().nullish(),
  numResults: z.number().int().min(1).max(15).nullish(),
  recencyDays: z.number().int().min(1).max(30).nullish()
});

const pipecatWebSearchArgsSchema = z.object({
  query: z.string().min(1),
  numResults: z.number().int().min(1).max(8).nullish(),
  recencyDays: z.number().int().min(1).max(365).nullish(),
  language: z.string().nullish(),
  regionCode: z.string().nullish(),
  includeDomains: z.array(z.string()).max(8).optional(),
  searchType: z.enum(['auto', 'fast', 'instant', 'neural', 'deep']).nullish()
});

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export const registerAgentRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const guard = requireAuth(auth);
  const deviceControl = new DeviceControlService();
  const mem0 = new Mem0Service();
  const reminders = new ReminderService();
  const care = new CareService();
  const nudges = new NudgesService();
  const companion = new CompanionService(reminders);
  const newsService = new NewsService();
  const webSearchService = new WebSearchService();
  const elderJourneyService = new ElderJourneyService(reminders);
  const elderContextService = new ElderContextService();
  const toolDefinitions = createToolDefinitions({
    religiousRetriever: new ReligiousRetriever(),
    mem0,
    reminderService: reminders,
    newsService,
    companionService: companion,
    diaryService: new DiaryService(),
    sessionDirector: new SessionDirectorService(),
    youtubeStreamService: new YoutubeStreamService(),
    panchangService: new PanchangService(new GeocodingService()),
    webSearchService,
    nudgesService: nudges,
    elderJourneyService,
    elderContextService
  });
  const toolByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

  app.get('/agent/conversations', { preHandler: guard }, async (request, reply) => {
    const parsed = cursorQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const userId = request.auth!.user.id;
    if (!isUuid(userId)) {
      return reply.send({ items: [], nextCursor: null });
    }

    const limit = parsed.data.limit ?? 20;
    const cursorId = parsed.data.cursor;

    let rows;
    if (cursorId) {
      const [cursorRow] = await db
        .select({ createdAt: conversationTurns.createdAt })
        .from(conversationTurns)
        .where(eq(conversationTurns.id, cursorId))
        .limit(1);
      if (cursorRow) {
        rows = await db
          .select()
          .from(conversationTurns)
          .where(and(eq(conversationTurns.userId, userId), lt(conversationTurns.createdAt, cursorRow.createdAt)))
          .orderBy(desc(conversationTurns.createdAt))
          .limit(limit);
      } else {
        rows = await db
          .select()
          .from(conversationTurns)
          .where(eq(conversationTurns.userId, userId))
          .orderBy(desc(conversationTurns.createdAt))
          .limit(limit);
      }
    } else {
      rows = await db
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.userId, userId))
        .orderBy(desc(conversationTurns.createdAt))
        .limit(limit);
    }

    const items = rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      userText: row.userText,
      assistantText: row.assistantText,
      language: row.language,
      citations: row.citations,
      createdAt: row.createdAt.toISOString()
    }));

    return reply.send({
      items,
      nextCursor: items.length > 0 ? items[items.length - 1]?.id : null
    });
  });

  app.get('/agent/memories', { preHandler: guard }, async (request, reply) => {
    const parsed = memoryQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const items = await mem0.searchMemory(request.auth!.user.id, parsed.data.query, parsed.data.k ?? 5);
    return reply.send({ items });
  });

  app.get('/agent/tasks', { preHandler: guard }, async (request, reply) => {
    const parsed = tasksQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const userId = request.auth!.user.id;
    const [reminderItems, careReminders, careRoutines, nudgeItems] = await Promise.all([
      reminders.listByUser(userId),
      care.listReminders(userId),
      care.listRoutines(userId),
      nudges.history(userId)
    ]);

    const fromTs = parsed.data.from ? Date.parse(parsed.data.from) : null;
    const toTs = parsed.data.to ? Date.parse(parsed.data.to) : null;

    const reminderTasks = reminderItems.map((item) => {
      const when = Date.parse(item.datetimeISO);
      return {
        id: item.id,
        type: 'reminder',
        title: item.title,
        when: Number.isNaN(when) ? null : new Date(when).toISOString(),
        status: Number.isNaN(when) || when > Date.now() ? 'pending' : 'done',
        recurrence: item.recurrence
      };
    });

    const careTasks = careReminders.map((item) => ({
      id: item.id,
      type: 'care_reminder',
      title: item.title,
      when: item.scheduledTime,
      status: item.enabled ? 'pending' : 'done',
      recurrence: null
    }));

    const routineTasks = careRoutines.map((item) => ({
      id: item.id,
      type: 'routine',
      title: item.title,
      when: item.schedule,
      status: item.enabled ? 'pending' : 'done',
      recurrence: 'daily'
    }));

    const nudgeTasks = nudgeItems.map((item) => ({
      id: item.id,
      type: 'scheduled_nudge',
      title: item.text ?? item.voiceUrl ?? 'Nudge',
      when: new Date(item.scheduledFor).toISOString(),
      status:
        item.deliveryState === 'acknowledged' || item.deliveryState === 'failed'
          ? 'done'
          : 'pending',
      recurrence: null
    }));

    const combined = [...reminderTasks, ...careTasks, ...routineTasks, ...nudgeTasks]
      .filter((task) => {
        if (!task.when) return true;
        const parsedWhen = Date.parse(task.when);
        if (Number.isNaN(parsedWhen)) return true;
        if (fromTs !== null && parsedWhen < fromTs) return false;
        if (toTs !== null && parsedWhen > toTs) return false;
        return true;
      })
      .filter((task) => {
        if (!parsed.data.status || parsed.data.status === 'all') return true;
        return task.status === parsed.data.status;
      })
      .sort((a, b) => {
        const ta = a.when ? Date.parse(a.when) : Number.MAX_SAFE_INTEGER;
        const tb = b.when ? Date.parse(b.when) : Number.MAX_SAFE_INTEGER;
        return ta - tb;
      });

    return reply.send({ items: combined });
  });

  app.post('/internal/pipecat/tool', { preHandler: requireInternalServiceAuth }, async (request, reply) => {
    const parsed = internalToolInvokeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const verifiedContext = await deviceControl.verifyPipecatToolContext(parsed.data.context);
    if (!verifiedContext) {
      return reply.status(403).send({ error: 'Pipecat tool context is not authorized for this user' });
    }

    const startedAt = Date.now();
    if (parsed.data.name === 'news_retrieve') {
      const input = pipecatNewsRetrieveArgsSchema.safeParse(parsed.data.arguments ?? {});
      if (!input.success) return reply.status(400).send({ error: input.error.flatten() });
      const items = await newsService.retrieve(input.data.query.trim(), {
        language: input.data.language ?? parsed.data.context.language,
        regionCode: input.data.regionCode ?? undefined,
        stateOrCity: input.data.stateOrCity ?? undefined,
        numResults: Math.max(input.data.numResults ?? 5, 5),
        recencyDays: input.data.recencyDays ?? undefined,
        freshness: input.data.freshness ?? 'latest'
      });
      return reply.send({
        ok: true,
        tool: 'news_retrieve',
        elapsedMs: Date.now() - startedAt,
        result: {
          status: 'ready',
          query: input.data.query.trim(),
          itemCount: items.length,
          items
        },
        clientEvents: []
      });
    }

    if (parsed.data.name === 'web_search') {
      const input = pipecatWebSearchArgsSchema.safeParse(parsed.data.arguments ?? {});
      if (!input.success) return reply.status(400).send({ error: input.error.flatten() });
      const items = await webSearchService.search(input.data.query.trim(), {
        numResults: input.data.numResults ?? undefined,
        recencyDays: input.data.recencyDays ?? undefined,
        language: input.data.language ?? parsed.data.context.language,
        regionCode: input.data.regionCode ?? undefined,
        includeDomains: input.data.includeDomains ?? undefined,
        searchType: input.data.searchType ?? undefined
      });
      return reply.send({
        ok: true,
        tool: 'web_search',
        elapsedMs: Date.now() - startedAt,
        result: {
          status: 'ready',
          query: input.data.query.trim(),
          itemCount: items.length,
          items
        },
        clientEvents: []
      });
    }

    const tool = toolByName.get(parsed.data.name);
    if (!tool) return reply.status(404).send({ error: `Unknown tool: ${parsed.data.name}` });

    const input = tool.parameters.safeParse(parsed.data.arguments ?? {});
    if (!input.success) return reply.status(400).send({ error: input.error.flatten() });

    const clientEvents: Array<{
      type: string;
      sourceTool: string;
      requestId?: string;
      payload?: Record<string, unknown>;
    }> = [];

    try {
      const result = await tool.execute(input.data, {
        userId: parsed.data.context.userId,
        deviceId: parsed.data.context.deviceId,
        familyId: parsed.data.context.familyId,
        elderId: parsed.data.context.elderId,
        language: parsed.data.context.language ?? 'hi-IN',
        sessionId: parsed.data.context.sessionId ?? `pipecat-${parsed.data.context.userId}`,
        getLastUserTranscript: () => parsed.data.context.lastUserTranscript ?? null,
        publishClientEvent: (event) => {
          clientEvents.push(event);
        }
      });
      return reply.send({
        ok: true,
        tool: tool.name,
        elapsedMs: Date.now() - startedAt,
        result,
        clientEvents
      });
    } catch (error) {
      return reply.status(500).send({
        ok: false,
        tool: tool.name,
        elapsedMs: Date.now() - startedAt,
        error: (error as Error).message
      });
    }
  });
};
