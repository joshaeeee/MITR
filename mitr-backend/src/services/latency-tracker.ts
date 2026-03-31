import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { observabilityConfig } from '../config/observability-config.js';

export interface TurnLatencyRecord {
  traceId: string;
  turnId: string;
  startedAt: number;
  agentStartMs?: number;
  agentFirstModelMs?: number;
  toolTotalMs?: number;
  ttsFirstChunkMs?: number;
  firstAudioMs?: number;
  turnTotalMs?: number;
  turnMode?: 'fast' | 'slow';
}

interface LatencySnapshot {
  totalTurns: number;
  recentCount: number;
  p50: number | null;
  p95: number | null;
  byMode: Record<string, { count: number; p50: number | null; p95: number | null }>;
}

const TURN_HISTORY_MAX = 500;

const percentile = (arr: number[], p: number): number | null => {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

const summarizeTurns = (
  turns: TurnLatencyRecord[]
): {
  totalTurns: number;
  recentCount: number;
  p50: number | null;
  p95: number | null;
  byMode: Record<string, { count: number; p50: number | null; p95: number | null }>;
} => {
  const withTotal = turns.filter((t) => typeof t.turnTotalMs === 'number') as Array<
    TurnLatencyRecord & { turnTotalMs: number }
  >;
  const totals = withTotal.map((t) => t.turnTotalMs);
  const byMode: LatencySnapshot['byMode'] = {};
  for (const mode of ['fast', 'slow']) {
    const modeTurns = withTotal.filter((t) => t.turnMode === mode).map((t) => t.turnTotalMs);
    byMode[mode] = {
      count: modeTurns.length,
      p50: percentile(modeTurns, 50),
      p95: percentile(modeTurns, 95)
    };
  }
  return {
    totalTurns: turns.length,
    recentCount: withTotal.length,
    p50: percentile(totals, 50),
    p95: percentile(totals, 95),
    byMode
  };
};

export class LatencyTracker {
  private turns: TurnLatencyRecord[] = [];

  private persistLocally(record: TurnLatencyRecord): void {
    if (!observabilityConfig.localLatencyTrackingEnabled) return;
    try {
      mkdirSync(path.dirname(observabilityConfig.localLatencyTrackingFile), { recursive: true });
      appendFileSync(observabilityConfig.localLatencyTrackingFile, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // Local latency tracking is best-effort for development only.
    }
  }

  private loadLocalTurns(): TurnLatencyRecord[] {
    if (!observabilityConfig.localLatencyTrackingEnabled || !existsSync(observabilityConfig.localLatencyTrackingFile)) {
      return this.turns;
    }
    try {
      const contents = readFileSync(observabilityConfig.localLatencyTrackingFile, 'utf8');
      const rows = contents
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .slice(-TURN_HISTORY_MAX)
        .map((line) => JSON.parse(line) as TurnLatencyRecord)
        .filter((row) => typeof row.turnTotalMs === 'number');
      return rows;
    } catch {
      return this.turns;
    }
  }

  recordTurn(record: TurnLatencyRecord): void {
    this.turns.push(record);
    if (this.turns.length > TURN_HISTORY_MAX) {
      this.turns = this.turns.slice(-TURN_HISTORY_MAX);
    }
    this.persistLocally(record);
  }

  snapshot(): LatencySnapshot {
    return summarizeTurns(this.loadLocalTurns());
  }
}

export const latencyTracker = new LatencyTracker();
