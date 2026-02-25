export type GuidedSessionStep =
  | { type: 'speak'; text: string }
  | { type: 'count'; label?: string; from?: number; to: number; intervalMs?: number }
  | { type: 'silence'; durationMs: number; note?: string };

export interface GuidedSessionPlan {
  id: string;
  kind: 'pranayama' | 'meditation' | 'satsang';
  title: string;
  totalEstimatedMs: number;
  ambientPreset?: 'tanpura_om' | 'flute_calm' | 'rain_soft';
  steps: GuidedSessionStep[];
}

export type GuidedSessionState =
  | { status: 'started'; sessionId: string; kind: GuidedSessionPlan['kind']; title: string }
  | { status: 'running'; sessionId: string; stepIndex: number; stepType: GuidedSessionStep['type'] }
  | { status: 'paused'; sessionId: string }
  | { status: 'resumed'; sessionId: string }
  | { status: 'stopped'; sessionId: string; reason?: string }
  | { status: 'completed'; sessionId: string };

export class GuidedSessionExecutor {
  private current?: {
    sessionId: string;
    plan: GuidedSessionPlan;
    paused: boolean;
    stopped: boolean;
    runPromise?: Promise<void>;
  };

  constructor(
    private readonly callbacks: {
      onSpeak: (text: string) => Promise<void>;
      onCounter: (payload: { label?: string; from: number; to: number; intervalMs: number }) => void;
      onState: (state: GuidedSessionState) => void;
    }
  ) {}

  start(plan: GuidedSessionPlan): string {
    this.stop('replaced_by_new_session');
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.current = {
      sessionId,
      plan,
      paused: false,
      stopped: false
    };
    this.callbacks.onState({ status: 'started', sessionId, kind: plan.kind, title: plan.title });
    this.current.runPromise = this.runCurrent();
    return sessionId;
  }

  pause(): void {
    if (!this.current || this.current.stopped) return;
    this.current.paused = true;
    this.callbacks.onState({ status: 'paused', sessionId: this.current.sessionId });
  }

  resume(): void {
    if (!this.current || this.current.stopped) return;
    this.current.paused = false;
    this.callbacks.onState({ status: 'resumed', sessionId: this.current.sessionId });
  }

  stop(reason?: string): void {
    if (!this.current) return;
    this.current.stopped = true;
    this.current.paused = false;
    this.callbacks.onState({ status: 'stopped', sessionId: this.current.sessionId, reason });
    this.current = undefined;
  }

  private async runCurrent(): Promise<void> {
    const run = this.current;
    if (!run) return;

    for (let i = 0; i < run.plan.steps.length; i += 1) {
      if (!this.current || this.current.sessionId !== run.sessionId || run.stopped) return;

      await this.waitIfPaused(run);
      if (!this.current || this.current.sessionId !== run.sessionId || run.stopped) return;

      const step = run.plan.steps[i];
      this.callbacks.onState({ status: 'running', sessionId: run.sessionId, stepIndex: i, stepType: step.type });

      if (step.type === 'speak') {
        await this.callbacks.onSpeak(step.text);
        continue;
      }

      if (step.type === 'count') {
        const from = step.from ?? 1;
        const to = Math.max(from, step.to);
        const intervalMs = step.intervalMs ?? 800;
        this.callbacks.onCounter({ label: step.label, from, to, intervalMs });
        await this.waitWithPause((to - from + 1) * intervalMs, run);
        continue;
      }

      if (step.type === 'silence') {
        await this.waitWithPause(step.durationMs, run);
      }
    }

    if (!this.current || this.current.sessionId !== run.sessionId || run.stopped) return;
    this.callbacks.onState({ status: 'completed', sessionId: run.sessionId });
    this.current = undefined;
  }

  private async waitIfPaused(run: { sessionId: string; paused: boolean; stopped: boolean }): Promise<void> {
    while (this.current && this.current.sessionId === run.sessionId && run.paused && !run.stopped) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  private async waitWithPause(ms: number, run: { sessionId: string; paused: boolean; stopped: boolean }): Promise<void> {
    let remaining = Math.max(0, ms);
    const tick = 100;
    while (remaining > 0) {
      if (!this.current || this.current.sessionId !== run.sessionId || run.stopped) return;
      if (run.paused) {
        await new Promise((resolve) => setTimeout(resolve, tick));
        continue;
      }
      const chunk = Math.min(tick, remaining);
      await new Promise((resolve) => setTimeout(resolve, chunk));
      remaining -= chunk;
    }
  }
}
