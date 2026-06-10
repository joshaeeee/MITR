import { rms } from "./pcm.js";

export type VadEvent = "speech_start" | "speech_end";

export interface VadConfig {
  sampleRate: number;
  startRms: number; // enter speech when RMS rises above this
  stopRms: number; // count as silence when RMS drops below this (hysteresis)
  startMs: number; // sustained voiced audio required to confirm speech start
  silenceMs: number; // trailing silence that ends the utterance
  maxUtteranceMs: number; // hard cap to force an end-of-turn
}

/**
 * Energy-based VAD endpointer with hysteresis. The ESP32 streams continuously and
 * never signals end-of-turn, so the gateway derives speech_start/speech_end here to
 * know when to finalize STT and kick the LLM.
 *
 * Feed it the same 16 kHz mono PCM16 frames you forward to STT.
 */
export class EnergyVad {
  private readonly cfg: VadConfig;
  private inSpeech = false;
  private voicedMs = 0; // accumulated voiced time while not yet in speech
  private silenceMs = 0; // accumulated trailing silence while in speech
  private utteranceMs = 0;

  constructor(cfg: VadConfig) {
    this.cfg = cfg;
  }

  get speaking(): boolean {
    return this.inSpeech;
  }

  /** Trailing silence accumulated so far while in speech (0 when actively voicing). */
  get trailingSilenceMs(): number {
    return this.inSpeech ? this.silenceMs : Number.POSITIVE_INFINITY;
  }

  /** Feed one PCM16 chunk; returns any state transition that occurred. */
  feed(pcm16: Buffer): VadEvent | null {
    const ms = ((pcm16.length >> 1) / this.cfg.sampleRate) * 1000;
    if (ms <= 0) return null;
    const level = rms(pcm16);

    if (!this.inSpeech) {
      if (level >= this.cfg.startRms) {
        this.voicedMs += ms;
        if (this.voicedMs >= this.cfg.startMs) {
          this.inSpeech = true;
          this.voicedMs = 0;
          this.silenceMs = 0;
          this.utteranceMs = 0;
          return "speech_start";
        }
      } else {
        // decay so brief blips don't accumulate into a false start
        this.voicedMs = Math.max(0, this.voicedMs - ms);
      }
      return null;
    }

    // in speech
    this.utteranceMs += ms;
    if (level < this.cfg.stopRms) {
      this.silenceMs += ms;
    } else {
      this.silenceMs = 0;
    }

    if (this.silenceMs >= this.cfg.silenceMs || this.utteranceMs >= this.cfg.maxUtteranceMs) {
      this.inSpeech = false;
      this.voicedMs = 0;
      this.silenceMs = 0;
      this.utteranceMs = 0;
      return "speech_end";
    }
    return null;
  }

  reset(): void {
    this.inSpeech = false;
    this.voicedMs = 0;
    this.silenceMs = 0;
    this.utteranceMs = 0;
  }
}
