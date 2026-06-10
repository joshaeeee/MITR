import { appendFileSync } from "node:fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { LatencyTurn } from "./types.js";

const logc = log.child({ mod: "latency" });

/**
 * Accumulates per-turn timing marks and emits a LatencyTurn record. All marks are
 * epoch-ms (performance.now()-style via Date.now is fine; we only diff within a turn).
 */
export class TurnTimer {
  private marks: Record<string, number> = {};
  readonly turnIndex: number;

  constructor(
    private readonly deviceId: string,
    private readonly sessionId: string,
    private readonly provider: string,
    turnIndex: number,
    private readonly wakePhrase?: string,
    private readonly wakeAtMs?: number,
  ) {
    this.turnIndex = turnIndex;
  }

  mark(name: string, t = Date.now()): void {
    if (this.marks[name] === undefined) this.marks[name] = t;
  }

  private diff(a: string, b: string): number | undefined {
    const x = this.marks[a];
    const y = this.marks[b];
    return x !== undefined && y !== undefined ? Math.max(0, Math.round(y - x)) : undefined;
  }

  finalize(): LatencyTurn {
    const speechEnd = this.marks.speechEnd;
    const firstAudio = this.marks.firstAudioOut;
    const rec: LatencyTurn = {
      deviceId: this.deviceId,
      sessionId: this.sessionId,
      turnIndex: this.turnIndex,
      provider: this.provider,
      wakePhrase: this.wakePhrase,
      sttFinalizeMs: this.diff("speechEnd", "sttFinal"),
      llmTtftMs: this.diff("sttFinal", "llmFirstDelta"),
      ttsFirstChunkMs: this.diff("llmFirstDelta", "ttsFirstChunk"),
      userFinalToFirstAudioMs: this.diff("speechEnd", "firstAudioOut"),
      turnTotalMs: this.diff("speechEnd", "lastAudioOut"),
      wakeToFirstAudioMs:
        this.wakeAtMs !== undefined && firstAudio !== undefined
          ? Math.max(0, Math.round(firstAudio - this.wakeAtMs))
          : undefined,
      toolCount: this.marks.toolCount,
      ts: new Date().toISOString(),
    };
    if (speechEnd === undefined) rec.userFinalToFirstAudioMs = undefined;
    return rec;
  }
}

export function emitLatency(rec: LatencyTurn): void {
  if (config.latencyLog) {
    logc.info("turn latency", { ...rec });
  }
  if (config.latencyJsonlPath) {
    try {
      appendFileSync(config.latencyJsonlPath, JSON.stringify(rec) + "\n");
    } catch (err) {
      logc.warn("latency jsonl write failed", { error: String(err) });
    }
  }
}
