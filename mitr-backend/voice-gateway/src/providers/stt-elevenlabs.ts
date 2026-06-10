import WebSocket from "ws";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { SttProvider, TranscriptEvent } from "../types.js";

/**
 * ElevenLabs Scribe v2 Realtime STT over WebSocket.
 *   wss://api.elevenlabs.io/v1/speech-to-text/realtime
 * Native pcm_16000 input (matches the ESP32 wire — no resampling). commit_strategy=manual;
 * the gateway drives finalization via flush() at VAD speech_end. Partial transcripts stream
 * continuously (wake matching + interim UI).
 *
 * Auto-reconnects: the realtime socket idles out after a long quiet stretch (e.g. while the
 * device plays a reply and the mic is echo-suppressed), so we transparently re-open it and
 * keep buffering audio across the gap.
 */
export class ElevenLabsStt implements SttProvider {
  private ws: WebSocket | null = null;
  private ready = false;
  private everReady = false;
  private closed = false;
  private pending: Buffer[] = []; // audio buffered while not ready
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((e: unknown) => void) | null = null;
  private transcriptCb: (t: TranscriptEvent) => void = () => {};
  private errorCb: (e: Error) => void = () => {};
  private readyCb: () => void = () => {};
  private readonly logc = log.child({ mod: "stt:elevenlabs" });

  constructor(private readonly sampleRate = config.audioInSampleRate) {}

  private url(): string {
    const params = new URLSearchParams({
      model_id: config.elevenlabsSttModel,
      audio_format: `pcm_${this.sampleRate}`,
      commit_strategy: "manual",
    });
    if (config.elevenlabsSttLanguage) params.set("language_code", config.elevenlabsSttLanguage);
    return `${config.elevenlabsSttBaseUrl}?${params.toString()}`;
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.openSocket();
      setTimeout(() => {
        if (!this.everReady) reject(new Error("elevenlabs stt connect timeout"));
      }, 6000);
    });
  }

  private openSocket(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url(), { headers: { "xi-api-key": config.elevenlabsApiKey } });
    this.ws = ws;

    ws.on("open", () => this.logc.debug("stt socket open"));
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.message_type) {
        case "session_started": {
          this.ready = true;
          const wasFirst = !this.everReady;
          this.everReady = true;
          for (const buf of this.pending) this.sendChunk(buf, false);
          this.pending = [];
          this.readyCb();
          if (wasFirst) this.connectResolve?.();
          else this.logc.debug("stt reconnected");
          break;
        }
        case "partial_transcript":
          this.transcriptCb({ text: String(msg.text ?? ""), isFinal: false });
          break;
        case "committed_transcript":
        case "committed_transcript_with_timestamps":
          this.transcriptCb({ text: String(msg.text ?? ""), isFinal: true });
          break;
        case "error":
          this.errorCb(new Error(String(msg.message ?? msg.error ?? "stt error")));
          break;
        default:
          break;
      }
    });
    ws.on("error", (err) => {
      this.errorCb(err as Error);
      if (!this.everReady) this.connectReject?.(err);
    });
    ws.on("close", () => {
      this.ready = false;
      if (!this.closed) {
        this.logc.warn("stt socket closed; reconnecting");
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, 400);
  }

  private sendChunk(pcm16: Buffer, commit: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: pcm16.length ? pcm16.toString("base64") : "",
        commit,
      }),
    );
  }

  sendAudio(pcm16: Buffer): void {
    if (this.closed) return;
    if (!this.ready) {
      this.pending.push(pcm16);
      if (this.pending.length > 150) this.pending.shift(); // bound to ~3s
      return;
    }
    this.sendChunk(pcm16, false);
  }

  flush(): void {
    if (this.closed || !this.ready) return;
    this.sendChunk(Buffer.alloc(0), true);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        // terminate() unconditionally: a CONNECTING socket would otherwise complete the
        // handshake and linger until the remote idles it out.
        this.ws.terminate();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
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
