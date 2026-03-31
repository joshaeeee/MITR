import { randomUUID } from 'node:crypto';
import { sessionConfig } from '../config/session-config.js';
import { getSharedRedisClient } from '../lib/redis.js';
import { db } from '../db/client.js';
import { userEventStream } from '../db/schema.js';
import { and, asc, eq, gte } from 'drizzle-orm';

export type SessionTerminationReason = 'client_end' | 'idle_timeout' | 'server_shutdown';

export interface SessionTurn {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface SessionRecord {
  userId: string;
  createdAt: number;
  lastActivityAt: number;
  terminatedAt?: number;
  terminationReason?: SessionTerminationReason;
  profileAnswers?: Record<string, string>;
}

export interface UserEventRecord {
  id: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
}

const sessionKey = (sessionId: string): string => `session:${sessionId}`;
const historyKey = (sessionId: string): string => `session:${sessionId}:history`;
const userHistoryKey = (userId: string): string => `user:${userId}:history`;
const userEventKey = (userId: string): string => `user:${userId}:events`;
const userEventDedupKey = (userId: string, dedupeKey: string): string => `user:${userId}:events:dedupe:${dedupeKey}`;

export class SessionStore {
  private redis = getSharedRedisClient();
  private memory = new Map<string, SessionRecord>();
  private memoryHistory = new Map<string, SessionTurn[]>();
  private memoryUserHistory = new Map<string, SessionTurn[]>();
  private memoryUserEvents = new Map<string, UserEventRecord[]>();
  private memoryEventDedup = new Map<string, number>();

  async create(userId: string, profileAnswers?: Record<string, string>): Promise<string> {
    const sessionId = randomUUID();
    const now = Date.now();
    const payload: SessionRecord = { userId, createdAt: now, lastActivityAt: now, profileAnswers };

    if (this.redis) {
      await this.redis.setex(sessionKey(sessionId), sessionConfig.deviceTokenTtlSec, JSON.stringify(payload));
      return sessionId;
    }

    this.memory.set(sessionId, payload);
    return sessionId;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    if (this.redis) {
      const raw = await this.redis.get(sessionKey(sessionId));
      return raw ? (JSON.parse(raw) as SessionRecord) : null;
    }

    return this.memory.get(sessionId) ?? null;
  }

  async touch(sessionId: string): Promise<void> {
    const current = await this.get(sessionId);
    if (!current) return;

    const updated: SessionRecord = { ...current, lastActivityAt: Date.now() };
    if (this.redis) {
      await this.redis.setex(sessionKey(sessionId), sessionConfig.deviceTokenTtlSec, JSON.stringify(updated));
      return;
    }

    this.memory.set(sessionId, updated);
  }

  async terminate(sessionId: string, reason: SessionTerminationReason): Promise<void> {
    const current = await this.get(sessionId);
    if (!current) return;

    const updated: SessionRecord = {
      ...current,
      terminatedAt: Date.now(),
      terminationReason: reason
    };

    if (this.redis) {
      await this.redis.setex(sessionKey(sessionId), sessionConfig.terminatedSessionTtlSec, JSON.stringify(updated));
      await this.redis.del(historyKey(sessionId));
      return;
    }

    this.memory.set(sessionId, updated);
    this.memoryHistory.delete(sessionId);
  }

  async appendTurn(sessionId: string, turn: SessionTurn): Promise<void> {
    if (this.redis) {
      await this.redis.rpush(historyKey(sessionId), JSON.stringify(turn));
      await this.redis.expire(historyKey(sessionId), sessionConfig.deviceTokenTtlSec);
      return;
    }

    const current = this.memoryHistory.get(sessionId) ?? [];
    current.push(turn);
    this.memoryHistory.set(sessionId, current);
  }

  async getTurns(sessionId: string, limit = 12): Promise<SessionTurn[]> {
    if (this.redis) {
      const start = Math.max(-limit, -200);
      const rows = await this.redis.lrange(historyKey(sessionId), start, -1);
      return rows
        .map((row) => {
          try {
            return JSON.parse(row) as SessionTurn;
          } catch {
            return null;
          }
        })
        .filter((row): row is SessionTurn => row !== null);
    }

    const turns = this.memoryHistory.get(sessionId) ?? [];
    return turns.slice(-limit);
  }

  async appendUserTurn(userId: string, turn: SessionTurn): Promise<void> {
    if (this.redis) {
      await this.redis.rpush(userHistoryKey(userId), JSON.stringify(turn));
      await this.redis.ltrim(userHistoryKey(userId), -sessionConfig.userHistoryMaxTurns, -1);
      await this.redis.expire(userHistoryKey(userId), sessionConfig.userHistoryTtlSec);
      return;
    }

    const current = this.memoryUserHistory.get(userId) ?? [];
    current.push(turn);
    this.memoryUserHistory.set(userId, current.slice(-sessionConfig.userHistoryMaxTurns));
  }

  async getUserTurns(userId: string, limit = 15): Promise<SessionTurn[]> {
    if (this.redis) {
      const start = Math.max(-limit, -sessionConfig.userHistoryMaxTurns);
      const rows = await this.redis.lrange(userHistoryKey(userId), start, -1);
      return rows
        .map((row) => {
          try {
            return JSON.parse(row) as SessionTurn;
          } catch {
            return null;
          }
        })
        .filter((row): row is SessionTurn => row !== null);
    }

    const turns = this.memoryUserHistory.get(userId) ?? [];
    return turns.slice(-limit);
  }

  async pushUserEvent(
    userId: string,
    event: Omit<UserEventRecord, 'id' | 'createdAt'>,
    dedupeKey?: string
  ): Promise<boolean> {
    const eventRecord: UserEventRecord = {
      id: randomUUID(),
      type: event.type,
      payload: event.payload,
      createdAt: Date.now()
    };

    if (this.redis) {
      if (dedupeKey) {
        const dedupe = await this.redis.set(userEventDedupKey(userId, dedupeKey), '1', 'EX', sessionConfig.userEventsTtlSec, 'NX');
        if (dedupe !== 'OK') return false;
      }
    } else if (dedupeKey) {
      const key = `${userId}:${dedupeKey}`;
      if (this.memoryEventDedup.has(key)) return false;
      this.memoryEventDedup.set(key, Date.now());
    }

    await db.insert(userEventStream).values({
      id: eventRecord.id,
      userId,
      eventType: eventRecord.type,
      payloadJson: eventRecord.payload,
      createdAt: new Date(eventRecord.createdAt)
    });

    if (this.redis) {
      await this.redis.rpush(userEventKey(userId), JSON.stringify(eventRecord));
      await this.redis.ltrim(userEventKey(userId), -sessionConfig.userEventsMax, -1);
      await this.redis.expire(userEventKey(userId), sessionConfig.userEventsTtlSec);
    }

    const current = this.memoryUserEvents.get(userId) ?? [];
    current.push(eventRecord);
    this.memoryUserEvents.set(userId, current.slice(-sessionConfig.userEventsMax));
    return true;
  }

  async pullUserEvents(userId: string, limit = 20, afterEventId?: string): Promise<UserEventRecord[]> {
    return this.streamUserEvents(userId, { limit, afterEventId });
  }

  async streamUserEvents(
    userId: string,
    options: {
      limit?: number;
      afterEventId?: string;
    } = {}
  ): Promise<UserEventRecord[]> {
    const limit = options.limit ?? 20;
    const afterEventId = options.afterEventId;
    const safeLimit = Math.max(1, Math.min(limit, sessionConfig.userEventsMax));

    let minCreatedAt: Date | null = null;
    if (afterEventId) {
      const [cursor] = await db
        .select({
          createdAt: userEventStream.createdAt
        })
        .from(userEventStream)
        .where(eq(userEventStream.id, afterEventId))
        .limit(1);
      minCreatedAt = cursor?.createdAt ?? null;
    }

    const rows = await db
      .select()
      .from(userEventStream)
      .where(
        minCreatedAt
          ? and(eq(userEventStream.userId, userId), gte(userEventStream.createdAt, minCreatedAt))
          : eq(userEventStream.userId, userId)
      )
      .orderBy(asc(userEventStream.createdAt), asc(userEventStream.id))
      .limit(sessionConfig.userEventsMax);

    const mapped = rows.map((row) => ({
      id: row.id,
      type: row.eventType,
      payload: row.payloadJson,
      createdAt: row.createdAt.getTime()
    }));

    if (!afterEventId) return mapped.slice(-safeLimit);

    const cursorIndex = mapped.findIndex((row) => row.id === afterEventId);
    if (cursorIndex < 0) return mapped.slice(0, safeLimit);
    return mapped.slice(cursorIndex + 1, cursorIndex + 1 + safeLimit);
  }
}
