import { SarvamAIClient } from "sarvamai";
import { config } from "../config.js";
import { log } from "../logger.js";
import { resampleLinear } from "../audio/pcm.js";
import type { TtsProvider } from "../types.js";

/**
 * Sarvam Bulbul v3 streaming TTS via the official `sarvamai` SDK Socket (India-hosted).
 * config (pcm_s16le @ speech_sample_rate) -> convert(text)* -> flush. Output base64 PCM is
 * resampled to the device's 16 kHz. The SDK handles the connect handshake/subprotocol that
 * a hand-rolled ws got wrong, and `pcm_s16le` is the valid raw-PCM codec (not "pcm").
 */
// Bulbul accepts a `convert` only if the text has at least one "speakable" char (a letter or
// digit). Punctuation/emoji/symbol/whitespace-only text is rejected — see appendText().
const HAS_SPEAKABLE = /[\p{L}\p{N}]/u;

type TtsSocket = {
  on: (event: string, cb: (arg: unknown) => void) => void;
  configureConnection?: (c: Record<string, unknown>) => void;
  configure?: (c: Record<string, unknown>) => void;
  convert: (text: string) => void;
  flush: () => void;
  close?: () => void;
  waitForOpen?: () => Promise<void>;
};

export class SarvamTts implements TtsProvider {
  private socket: TtsSocket | null = null;
  private opened = false;
  private cancelled = false;
  private finished = false;
  private queued: string[] = [];
  private pendingFrag = ""; // non-speakable fragments carried forward to the next real chunk
  private audioCb: (pcm16: Buffer) => void = () => {};
  private doneCb: () => void = () => {};
  private errorCb: (e: Error) => void = () => {};
  private readonly logc = log.child({ mod: "tts:sarvam" });

  async connect(): Promise<void> {
    await Promise.race([
      this.doConnect(),
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error("sarvam tts connect timeout")), 6000)),
    ]);
  }

  private async doConnect(): Promise<void> {
    const client = new SarvamAIClient({ apiSubscriptionKey: config.sarvamApiKey });
    this.logc.debug("tts connecting");
    const socket = (await (
      client.textToSpeechStreaming as unknown as {
        connect: (p: Record<string, string>) => Promise<TtsSocket>;
      }
    ).connect({ model: config.sarvamTtsModel, send_completion_event: "true" })) as TtsSocket;
    this.socket = socket;

    socket.on("message", (raw) => {
      const m = raw as { type?: string; data?: Record<string, unknown> };
      const d = m.data ?? {};
      if (m.type === "error") {
        this.logc.warn("sarvam tts error", { raw: JSON.stringify(raw).slice(0, 300) });
        this.errorCb(new Error("sarvam tts: " + JSON.stringify(d)));
        return;
      }
      if (m.type === "audio" && typeof d.audio === "string" && d.audio.length) {
        if (!this.cancelled) {
          const pcm = resampleLinear(
            Buffer.from(d.audio, "base64"),
            config.sarvamTtsSampleRate,
            config.audioOutSampleRate,
          );
          this.audioCb(pcm);
        }
      } else if (d.event_type === "final" || m.type === "event" || m.type === "events") {
        this.doneCb();
      }
    });
    socket.on("error", (e) => this.errorCb(e instanceof Error ? e : new Error(String(e))));
    socket.on("close", () => this.doneCb());

    if (typeof socket.waitForOpen === "function") await socket.waitForOpen();
    this.logc.debug("tts open; configuring", { hasConfigure: typeof (socket.configureConnection ?? socket.configure) });
    this.opened = true;
    // Flat params (the SDK wraps them into {type:"config",data:{...}} and fills defaults).
    // Codec MUST be "linear16" for raw 16-bit PCM: the server rejects "pcm_s16le" with a 422
    // "Input parameters has to be a valid dictionary" despite it being in the SDK enum.
    const cfg: Record<string, unknown> = {
      target_language_code: config.sarvamTtsLanguage,
      speaker: config.sarvamTtsSpeaker,
      output_audio_codec: "linear16",
      speech_sample_rate: config.sarvamTtsSampleRate,
      pace: config.sarvamTtsPace,
    };
    (socket.configureConnection ?? socket.configure)?.call(socket, cfg);
    for (const t of this.queued) socket.convert(t);
    this.queued = [];
    if (this.finished) socket.flush();
  }

  appendText(text: string): void {
    if (this.cancelled || this.finished || !text) return;
    // Bulbul rejects any `convert` whose text has no speakable char — punctuation-only,
    // emoji-only, symbol-only, or whitespace-only — with a 400 ("'text' cannot be empty" or
    // "Text must contain at least one character from the allowed languages"), AND that error
    // CLOSES the socket, killing the rest of the turn's audio. The LLM streams such fragments
    // constantly (a leading "\n", a lone "!", an emoji, a markdown "*"). So carry any
    // non-speakable fragment forward and prepend it to the next chunk that has a letter/digit.
    // (Latin text and digits are accepted under hi-IN, so no per-language gating is needed.)
    const combined = this.pendingFrag + text;
    if (!HAS_SPEAKABLE.test(combined)) {
      this.pendingFrag = combined;
      return;
    }
    this.pendingFrag = "";
    if (!this.opened || !this.socket) {
      this.queued.push(combined);
      return;
    }
    this.socket.convert(combined);
  }

  finish(): void {
    if (this.cancelled || this.finished) return;
    this.finished = true;
    try {
      this.socket?.flush();
    } catch {
      /* ignore */
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    try {
      this.socket?.close?.();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  onAudio(cb: (pcm16: Buffer) => void): void {
    this.audioCb = cb;
  }
  onDone(cb: () => void): void {
    let fired = false;
    this.doneCb = () => {
      if (fired) return;
      fired = true;
      cb();
    };
  }
  onError(cb: (e: Error) => void): void {
    this.errorCb = cb;
  }
}
