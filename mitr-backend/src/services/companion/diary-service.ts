import { Redis } from 'ioredis';
import { getSharedRedisClient } from '../../lib/redis.js';

export interface DiaryEntry {
  ts: number;
  text: string;
  mood?: string;
  tags?: string[];
}

const diaryKey = (userId: string): string => `diary:${userId}`;
const DIARY_MAX = 500;
const DIARY_TTL_SEC = 60 * 60 * 24 * 365;

export class DiaryService {
  private redis?: Redis;
  private memory = new Map<string, DiaryEntry[]>();

  constructor() {
    this.redis = getSharedRedisClient() ?? undefined;
  }

  async add(userId: string, entry: DiaryEntry): Promise<void> {
    if (this.redis) {
      await this.redis.rpush(diaryKey(userId), JSON.stringify(entry));
      await this.redis.ltrim(diaryKey(userId), -DIARY_MAX, -1);
      await this.redis.expire(diaryKey(userId), DIARY_TTL_SEC);
      return;
    }

    const current = this.memory.get(userId) ?? [];
    current.push(entry);
    this.memory.set(userId, current.slice(-DIARY_MAX));
  }

  async list(userId: string, limit = 10): Promise<DiaryEntry[]> {
    if (this.redis) {
      const rows = await this.redis.lrange(diaryKey(userId), -Math.max(limit, 1), -1);
      return rows
        .map((row) => {
          try {
            return JSON.parse(row) as DiaryEntry;
          } catch {
            return null;
          }
        })
        .filter((row): row is DiaryEntry => row !== null);
    }

    return (this.memory.get(userId) ?? []).slice(-Math.max(limit, 1));
  }
}
