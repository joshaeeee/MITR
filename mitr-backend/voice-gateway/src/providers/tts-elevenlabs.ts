import WebSocket from "ws";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { TtsProvider } from "../types.js";

/**
 * ElevenLabs Flash v2.5 streaming TTS (stream-input WebSocket).
 *   wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
 * output_format=pcm_16000 => raw PCM16 16k, no resampling for the ESP32 wire.
 * One socket per spoken response: connect -> appendText* -> finish.
 */
export class ElevenLabsTts implements TtsProvider {
  private ws: WebSocket | null = null;
  private opened = false;
  private cancelled = false;
  private finished = false;
  private finishRequested = false; // finish() called before the socket opened
  private queued: string[] = []; // text queued before socket open
  private audioCb: (pcm16: Buffer) => void = () => {};
  private doneCb: () => void = () => {};
  private errorCb: (e: Error) => void = () => {};
  private readonly logc = log.child({ mod: "tts:elevenlabs" });

  connect(): Promise<void> {
    const params = new URLSearchParams({
      model_id: config.elevenlabsTtsModel,
      output_format: `pcm_${config.audioOutSampleRate}`,
      auto_mode: String(config.elevenlabsAutoMode),
    });
    if (config.elevenlabsTtsLanguage) params.set("language_code", config.elevenlabsTtsLanguage);
    const url = `${config.elevenlabsTtsBaseUrl}/v1/text-to-speech/${encodeURIComponent(
      config.elevenlabsVoiceId,
    )}/stream-input?${params.toString()}`;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { "xi-api-key": config.elevenlabsApiKey } });
      this.ws = ws;
      let settled = false;

      ws.on("open", () => {
        this.opened = true;
        // Initialize the stream (voice settings + generation config).
        const init: Record<string, unknown> = {
          text: " ",
          voice_settings: {
            stability: config.elevenlabsStability,
            similarity_boost: config.elevenlabsSimilarityBoost,
            style: config.elevenlabsStyle,
            use_speaker_boost: config.elevenlabsUseSpeakerBoost,
            speed: config.elevenlabsSpeed,
          },
        };
        // chunk_length_schedule is ignored under auto_mode; only send when off.
        if (!config.elevenlabsAutoMode) {
          init.generation_config = { chunk_length_schedule: config.elevenlabsChunkLengthSchedule };
        }
        ws.send(JSON.stringify(init));
        // Drain any text queued before open.
        for (const t of this.queued) this.rawSendText(t);
        this.queued = [];
        // If the LLM finished before the socket opened, flush now.
        if (this.finishRequested) this.sendFinish();
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (typeof msg.audio === "string" && msg.audio.length) {
          if (!this.cancelled) this.audioCb(Buffer.from(msg.audio, "base64"));
        }
        if (msg.isFinal === true) {
          this.doneCb();
        }
      });

      ws.on("error", (err) => {
        this.errorCb(err as Error);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      ws.on("close", () => {
        this.opened = false;
        if (!this.finished && !this.cancelled) this.logc.warn("tts socket closed early");
        // Ensure the consumer is released even if isFinal never arrived.
        this.doneCb();
      });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          // Surface through errorCb + kill the socket so a session that already swallowed
          // this rejection (speculative connect) still resolves its ttsDone via onError/
          // onClose instead of stalling the full drain-safety window.
          const err = new Error("elevenlabs tts connect timeout");
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          this.errorCb(err);
          reject(err);
        }
      }, 6000);
    });
  }

  private rawSendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Trailing space helps the model decide word boundaries between chunks.
    const t = text.endsWith(" ") ? text : text + " ";
    this.ws.send(JSON.stringify({ text: t, flush: false }));
  }

  appendText(text: string): void {
    if (this.cancelled || this.finished || !text) return;
    if (!this.opened) {
      this.queued.push(text);
      return;
    }
    this.rawSendText(text);
  }

  private sendFinish(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // flush then signal end-of-input (empty text closes the generation).
    this.ws.send(JSON.stringify({ text: " ", flush: true }));
    this.ws.send(JSON.stringify({ text: "" }));
  }

  finish(): void {
    if (this.cancelled || this.finished) return;
    this.finished = true;
    if (this.opened) this.sendFinish();
    else this.finishRequested = true; // flush once the socket opens
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }

  onAudio(cb: (pcm16: Buffer) => void): void {
    this.audioCb = cb;
  }
  onDone(cb: () => void): void {
    // Guard against double-fire (isFinal + close).
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
