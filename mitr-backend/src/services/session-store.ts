import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { getSharedRedisClient } from '../lib/redis.js';

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
const USER_HISTORY_TTL_SEC = 60 * 60 * 24 * 30;
const USER_HISTORY_MAX_TURNS = 300;
const USER_EVENTS_TTL_SEC = 60 * 60 * 24 * 30;
const USER_EVENTS_MAX = 200;

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
      await this.redis.setex(sessionKey(sessionId), env.DEVICE_TOKEN_TTL_SEC, JSON.stringify(payload));
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
      await this.redis.setex(sessionKey(sessionId), env.DEVICE_TOKEN_TTL_SEC, JSON.stringify(updated));
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
      await this.redis.setex(sessionKey(sessionId), Math.min(env.DEVICE_TOKEN_TTL_SEC, 3600), JSON.stringify(updated));
      await this.redis.del(historyKey(sessionId));
      return;
    }

    this.memory.set(sessionId, updated);
    this.memoryHistory.delete(sessionId);
  }

  async appendTurn(sessionId: string, turn: SessionTurn): Promise<void> {
    if (this.redis) {
      await this.redis.rpush(historyKey(sessionId), JSON.stringify(turn));
      await this.redis.expire(historyKey(sessionId), env.DEVICE_TOKEN_TTL_SEC);
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
      await this.redis.ltrim(userHistoryKey(userId), -USER_HISTORY_MAX_TURNS, -1);
      await this.redis.expire(userHistoryKey(userId), USER_HISTORY_TTL_SEC);
      return;
    }

    const current = this.memoryUserHistory.get(userId) ?? [];
    current.push(turn);
    this.memoryUserHistory.set(userId, current.slice(-USER_HISTORY_MAX_TURNS));
  }

  async getUserTurns(userId: string, limit = 15): Promise<SessionTurn[]> {
    if (this.redis) {
      const start = Math.max(-limit, -USER_HISTORY_MAX_TURNS);
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
        const dedupe = await this.redis.set(userEventDedupKey(userId, dedupeKey), '1', 'EX', USER_EVENTS_TTL_SEC, 'NX');
        if (dedupe !== 'OK') return false;
      }
      await this.redis.rpush(userEventKey(userId), JSON.stringify(eventRecord));
      await this.redis.ltrim(userEventKey(userId), -USER_EVENTS_MAX, -1);
      await this.redis.expire(userEventKey(userId), USER_EVENTS_TTL_SEC);
      return true;
    }

    if (dedupeKey) {
      const key = `${userId}:${dedupeKey}`;
      if (this.memoryEventDedup.has(key)) return false;
      this.memoryEventDedup.set(key, Date.now());
    }

    const current = this.memoryUserEvents.get(userId) ?? [];
    current.push(eventRecord);
    this.memoryUserEvents.set(userId, current.slice(-USER_EVENTS_MAX));
    return true;
  }

  async pullUserEvents(userId: string, limit = 20): Promise<UserEventRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, USER_EVENTS_MAX));

    if (this.redis) {
      const rows = await this.redis.lrange(userEventKey(userId), 0, safeLimit - 1);
      if (rows.length > 0) {
        await this.redis.ltrim(userEventKey(userId), rows.length, -1);
      }
      return rows
        .map((row) => {
          try {
            return JSON.parse(row) as UserEventRecord;
          } catch {
            return null;
          }
        })
        .filter((row): row is UserEventRecord => row !== null);
    }

    const queue = this.memoryUserEvents.get(userId) ?? [];
    const events = queue.slice(0, safeLimit);
    this.memoryUserEvents.set(userId, queue.slice(events.length));
    return events;
  }
}
