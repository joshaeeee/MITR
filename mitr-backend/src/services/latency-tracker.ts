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

export class LatencyTracker {
  private turns: TurnLatencyRecord[] = [];

  recordTurn(record: TurnLatencyRecord): void {
    this.turns.push(record);
    if (this.turns.length > TURN_HISTORY_MAX) {
      this.turns = this.turns.slice(-TURN_HISTORY_MAX);
    }
  }

  snapshot(): LatencySnapshot {
    const withTotal = this.turns.filter((t) => typeof t.turnTotalMs === 'number') as Array<TurnLatencyRecord & { turnTotalMs: number }>;
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
      totalTurns: this.turns.length,
      recentCount: withTotal.length,
      p50: percentile(totals, 50),
      p95: percentile(totals, 95),
      byMode
    };
  }
}

export const latencyTracker = new LatencyTracker();
