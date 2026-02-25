interface BlockTiming {
  blockType: string;
  durationMs: number;
}

interface SessionDuration {
  durationSec: number;
}

const percentile = (arr: number[], p: number): number | null => {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
};

const MAX_SAMPLES = 1000;

export class LongSessionMetrics {
  private started = 0;
  private completed = 0;
  private resumeAttempts = 0;
  private resumeSuccess = 0;
  private orphanRunningBlocksTotal = 0;
  private blockTimings: BlockTiming[] = [];
  private transitionMs: number[] = [];
  private sessionDurations: SessionDuration[] = [];

  recordStarted(): void {
    this.started += 1;
  }

  recordCompleted(durationSec: number): void {
    this.completed += 1;
    this.sessionDurations.push({ durationSec: Math.max(0, durationSec) });
    if (this.sessionDurations.length > MAX_SAMPLES) {
      this.sessionDurations = this.sessionDurations.slice(-MAX_SAMPLES);
    }
  }

  recordBlockExecution(blockType: string, durationMs: number): void {
    this.blockTimings.push({ blockType, durationMs: Math.max(0, durationMs) });
    if (this.blockTimings.length > MAX_SAMPLES) {
      this.blockTimings = this.blockTimings.slice(-MAX_SAMPLES);
    }
  }

  recordTransition(durationMs: number): void {
    this.transitionMs.push(Math.max(0, durationMs));
    if (this.transitionMs.length > MAX_SAMPLES) {
      this.transitionMs = this.transitionMs.slice(-MAX_SAMPLES);
    }
  }

  recordResumeAttempt(success: boolean): void {
    this.resumeAttempts += 1;
    if (success) this.resumeSuccess += 1;
  }

  addOrphanRunningBlocks(count: number): void {
    this.orphanRunningBlocksTotal += Math.max(0, count);
  }

  snapshot(): {
    long_session_started_total: number;
    long_session_completed_total: number;
    long_session_avg_duration_sec: number;
    block_exec_p95_ms_by_type: Record<string, number | null>;
    block_transition_p95_ms: number | null;
    resume_success_rate: number;
    orphan_running_blocks_total: number;
  } {
    const byType: Record<string, number[]> = {};
    for (const row of this.blockTimings) {
      byType[row.blockType] = byType[row.blockType] ?? [];
      byType[row.blockType].push(row.durationMs);
    }

    const blockP95ByType: Record<string, number | null> = {};
    for (const [key, values] of Object.entries(byType)) {
      blockP95ByType[key] = percentile(values, 95);
    }

    const totalDuration = this.sessionDurations.reduce((sum, d) => sum + d.durationSec, 0);
    const avgDuration = this.sessionDurations.length ? totalDuration / this.sessionDurations.length : 0;

    return {
      long_session_started_total: this.started,
      long_session_completed_total: this.completed,
      long_session_avg_duration_sec: Math.round(avgDuration),
      block_exec_p95_ms_by_type: blockP95ByType,
      block_transition_p95_ms: percentile(this.transitionMs, 95),
      resume_success_rate: this.resumeAttempts > 0 ? this.resumeSuccess / this.resumeAttempts : 1,
      orphan_running_blocks_total: this.orphanRunningBlocksTotal
    };
  }
}

export const longSessionMetrics = new LongSessionMetrics();
