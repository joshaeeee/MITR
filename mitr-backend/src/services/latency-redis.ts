import { getSharedRedisClient } from '../lib/redis.js';

const LATENCY_KEY = 'mitr:latency:turns';
const MAX_ENTRIES = 500;
const ENTRY_TTL_SEC = 3600;

export interface LatencyRecord {
  traceId: string;
  turnId: number;
  startedAt: number;
  totalMs: number;
  sttFinalizeMs: number | null;
  modelTtftMs: number | null;
  firstAudioMs: number | null;
  firstAssistantTextMs: number | null;
  toolCount: number;
  totalToolMs: number;
  toolNames: string[];
}

export async function pushLatencyRecord(record: LatencyRecord): Promise<void> {
  const redis = getSharedRedisClient();
  if (!redis) return;
  try {
    await redis.lpush(LATENCY_KEY, JSON.stringify(record));
    await redis.ltrim(LATENCY_KEY, 0, MAX_ENTRIES - 1);
    await redis.expire(LATENCY_KEY, ENTRY_TTL_SEC);
  } catch {
    // best-effort; don't crash the agent worker
  }
}

export async function readLatencyRecords(): Promise<LatencyRecord[]> {
  const redis = getSharedRedisClient();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(LATENCY_KEY, 0, MAX_ENTRIES - 1);
    return raw.map((r) => JSON.parse(r) as LatencyRecord);
  } catch {
    return [];
  }
}

const percentile = (arr: number[], p: number): number | null => {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

export async function redisLatencySnapshot() {
  const records = await readLatencyRecords();
  const totals = records.map((r) => r.totalMs);
  const firstAudios = records.filter((r) => r.firstAudioMs != null).map((r) => r.firstAudioMs!);
  const ttfts = records.filter((r) => r.modelTtftMs != null).map((r) => r.modelTtftMs!);

  const withTools = records.filter((r) => r.toolCount > 0);
  const withoutTools = records.filter((r) => r.toolCount === 0);

  return {
    totalTurns: records.length,
    turnTotal: { p50: percentile(totals, 50), p95: percentile(totals, 95) },
    firstAudio: { p50: percentile(firstAudios, 50), p95: percentile(firstAudios, 95) },
    modelTtft: { p50: percentile(ttfts, 50), p95: percentile(ttfts, 95) },
    byMode: {
      fast: {
        count: withoutTools.length,
        p50: percentile(withoutTools.map((r) => r.totalMs), 50),
        p95: percentile(withoutTools.map((r) => r.totalMs), 95)
      },
      slow: {
        count: withTools.length,
        p50: percentile(withTools.map((r) => r.totalMs), 50),
        p95: percentile(withTools.map((r) => r.totalMs), 95)
      }
    }
  };
}
