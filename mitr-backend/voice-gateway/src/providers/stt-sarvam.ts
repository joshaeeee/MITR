import { SarvamAIClient } from "sarvamai";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { SttProvider, TranscriptEvent } from "../types.js";

/**
 * Sarvam Saaras v3 streaming STT via the official `sarvamai` SDK Socket (India-hosted ->
 * low RTT from India). The SDK handles the exact connect handshake/subprotocol/framing
 * that a hand-rolled ws client got subtly wrong. We stream raw PCM s16le chunks.
 *
 * Final behavior: in transcribe mode Saaras emits NO interims — each `data` message is the
 * committed transcript of a VAD segment, arriving ~200ms after its own END_SPEECH signal
 * (i.e. usually BEFORE the gateway's energy-VAD hangover elapses). Surface them as finals
 * immediately; flush() stays as a safety net to force out a trailing buffered segment.
 */
// The SDK is fern-generated; its Socket type isn't exported cleanly, so we type loosely.
type SarvamSocket = {
  on: (event: string, cb: (arg: unknown) => void) => void;
  transcribe: (p: { audio: string; sample_rate: number; encoding: string }) => void;
  flush?: () => void;
  close?: () => void;
  waitForOpen?: () => Promise<void>;
};

export class SarvamStt implements SttProvider {
  private socket: SarvamSocket | null = null;
  private ready = false;
  private closed = false;
  private pending: Buffer[] = [];
  private pendingFinal = false;
  private transcriptCb: (t: TranscriptEvent) => void = () => {};
  private errorCb: (e: Error) => void = () => {};
  private readyCb: () => void = () => {};
  private readonly logc = log.child({ mod: "stt:sarvam" });

  constructor(private readonly sampleRate = config.audioInSampleRate) {}

  async connect(): Promise<void> {
    const client = new SarvamAIClient({ apiSubscriptionKey: config.sarvamApiKey });
    const params: Record<string, string> = {
      model: config.sarvamSttModel,
      "language-code": config.sarvamSttLanguage,
      input_audio_codec: "pcm_s16le",
      sample_rate: String(this.sampleRate),
      high_vad_sensitivity: "true",
      vad_signals: "true",
    };
    if (config.sarvamSttMode) params.mode = config.sarvamSttMode;

    const socket = (await (
      client.speechToTextStreaming as unknown as {
        connect: (p: Record<string, string>) => Promise<SarvamSocket>;
      }
    ).connect(params)) as SarvamSocket;
    this.socket = socket;

    socket.on("message", (raw) => {
      const r = raw as { type?: string; data?: Record<string, unknown> };
      const data = r.data ?? {};
      if (r.type === "data" || r.type === "transcript") {
        const text = String((data.transcript ?? data.text ?? "") as string);
        if (text) {
          this.pendingFinal = false;
          this.transcriptCb({ text, isFinal: true }); // every segment transcript is committed
        }
      } else if (r.type === "error") {
        this.errorCb(new Error(String(data.error ?? data.message ?? "sarvam stt error")));
      }
    });
    socket.on("error", (e) => this.errorCb(e instanceof Error ? e : new Error(String(e))));
    socket.on("close", () => {
      this.ready = false;
      if (!this.closed) this.logc.warn("stt socket closed; SDK will reconnect");
    });
    // The SDK socket auto-reconnects (backoff, 30 retries); 'open' fires again on each
    // reconnect. Without this, `ready` stays false after a blip and STT goes deaf.
    socket.on("open", () => {
      this.ready = true;
      for (const b of this.pending) this.send(b);
      this.pending = [];
    });

    if (typeof socket.waitForOpen === "function") await socket.waitForOpen();
    this.ready = true;
    for (const b of this.pending) this.send(b);
    this.pending = [];
    this.readyCb();
  }

  private send(pcm16: Buffer): void {
    if (!this.socket || pcm16.length === 0) return;
    try {
      this.socket.transcribe({ audio: pcm16.toString("base64"), sample_rate: this.sampleRate, encoding: "audio/wav" });
    } catch (e) {
      this.logc.debug("transcribe send failed", { error: String(e) });
    }
  }

  sendAudio(pcm16: Buffer): void {
    if (this.closed) return;
    if (!this.ready || !this.socket) {
      this.pending.push(pcm16);
      if (this.pending.length > 150) this.pending.shift();
      return;
    }
    this.send(pcm16);
  }

  flush(): void {
    if (this.closed || !this.socket) return;
    this.pendingFinal = true;
    try {
      this.socket.flush?.();
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      this.socket?.close?.();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  onTranscript(cb: (t: TranscriptEvent) => void): void {
    this.transcriptCb = cb;
  }
  onError(cb: (e: Error) => void): void {
    this.errorCb = cb;
  }
  onReady(cb: () => void): void {
    this.readyCb = cb;
  }
}
