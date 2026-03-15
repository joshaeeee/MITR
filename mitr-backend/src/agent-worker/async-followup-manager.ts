export interface FollowupSession {
  generateReply(input: { instructions: string }): void;
  say?(text: string): void;
}

export interface AsyncFollowupEntry {
  type: string;
  requestId: string;
  payload: Record<string, unknown>;
  buildInstructions: (payload: Record<string, unknown>) => string;
  buildSpeech?: (payload: Record<string, unknown>) => string | null;
}

export interface AsyncFollowupManagerOptions {
  delayMs: number;
  onTriggered?: (entry: AsyncFollowupEntry) => void;
}

export class AsyncFollowupManager {
  private readonly delayMs: number;
  private readonly onTriggered?: (entry: AsyncFollowupEntry) => void;
  private readonly pending = new Map<string, AsyncFollowupEntry>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(options: AsyncFollowupManagerOptions) {
    this.delayMs = options.delayMs;
    this.onTriggered = options.onTriggered;
  }

  schedule(entry: AsyncFollowupEntry): void {
    this.pending.set(entry.type, entry);
  }

  clear(type?: string): void {
    if (type) {
      const timer = this.timers.get(type);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(type);
      }
      this.pending.delete(type);
      return;
    }

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.pending.clear();
  }

  flushEligible(session: FollowupSession | null, canFlush: () => boolean): void {
    if (!session) return;
    for (const type of this.pending.keys()) {
      if (this.timers.has(type)) continue;
      if (!canFlush()) continue;

      const timeout = setTimeout(() => {
        this.timers.delete(type);
        if (!canFlush()) return;

        const entry = this.pending.get(type);
        if (!entry) return;

        this.pending.delete(type);
        this.onTriggered?.(entry);
        const speech = entry.buildSpeech?.(entry.payload)?.trim();
        if (speech && speech.length > 0 && typeof session.say === 'function') {
          session.say(speech);
          return;
        }
        session.generateReply({ instructions: entry.buildInstructions(entry.payload) });
      }, this.delayMs);

      this.timers.set(type, timeout);
    }
  }
}
