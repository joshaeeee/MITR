import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { conversationTurns } from '../db/schema.js';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { Mem0Service } from '../services/memory/mem0-service.js';
import { ReminderService } from '../services/reminders/reminder-service.js';
import { CareService } from '../services/care/care-service.js';
import { NudgesService } from '../services/nudges/nudges-service.js';

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

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export const registerAgentRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const guard = requireAuth(auth);
  const mem0 = new Mem0Service();
  const reminders = new ReminderService();
  const care = new CareService();
  const nudges = new NudgesService();

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
};
