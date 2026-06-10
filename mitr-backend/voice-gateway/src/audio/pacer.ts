// Outbound audio pacer.
//
// The ESP32 playback queue is only GATEWAY_QUEUE_DEPTH (24) frames (~480 ms) deep
// and drops frames on overflow (xQueueSend with 0 timeout). TTS produces audio far
// faster than real-time, so we MUST pace sends to roughly real-time, keeping at most
// LEAD_MS of audio buffered on the device. The first frame still goes out immediately
// (first-audio latency is unaffected); only subsequent frames are paced.

export class AudioPacer {
  private queue: Buffer[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Virtual playback clock: epoch ms at which the last queued frame finishes playing. */
  private scheduled = 0;
  private firstFired = false;
  private drainResolvers: Array<() => void> = [];

  constructor(
    private readonly send: (frame: Buffer) => void,
    private readonly frameMs: number,
    private readonly leadMs: number,
    private readonly onFirstFrame?: () => void,
  ) {}

  /** epoch ms at which all enqueued audio will have finished playing on the device. */
  get playbackEndsAt(): number {
    // `scheduled` only advances as frames are SENT; audio still waiting in the queue
    // must be counted too, or echo suppression opens the mic mid-playback.
    return Math.max(this.scheduled, Date.now()) + this.queue.length * this.frameMs;
  }

  enqueue(frame: Buffer): void {
    this.queue.push(frame);
    if (!this.timer) this.tick();
  }

  private tick = (): void => {
    this.timer = null;
    if (this.queue.length === 0) {
      const resolvers = this.drainResolvers;
      this.drainResolvers = [];
      for (const r of resolvers) r();
      return;
    }
    const now = Date.now();
    if (this.scheduled < now) this.scheduled = now; // fell behind real time; catch up

    if (this.scheduled <= now + this.leadMs) {
      const frame = this.queue.shift()!;
      this.send(frame);
      if (!this.firstFired) {
        this.firstFired = true;
        this.onFirstFrame?.();
      }
      this.scheduled += this.frameMs;
      // Try to send the next frame right away if still within the lead window.
      this.timer = setTimeout(this.tick, 0);
    } else {
      this.timer = setTimeout(this.tick, this.scheduled - now - this.leadMs);
    }
  };

  /** Resolves once all currently-queued audio has been sent. */
  whenDrained(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainResolvers.push(resolve));
  }

  /** Drop all queued audio immediately (barge-in / turn end). */
  clear(): void {
    this.queue = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const resolvers = this.drainResolvers;
    this.drainResolvers = [];
    for (const r of resolvers) r();
  }

  /** True once the queue is fully drained. */
  get drained(): boolean {
    return this.queue.length === 0 && this.timer === null;
  }
}
