import { config } from "../config.js";
import { log } from "../logger.js";
import type { TtsProvider } from "../types.js";

/**
 * ElevenLabs HTTP-streaming TTS for models with NO realtime stream-input socket (Eleven v3 —
 * the expressive model; the WS endpoint 403s it). LLM deltas are buffered into sentences and
 * each sentence is POSTed to /v1/text-to-speech/{voice}/stream (output pcm_16000).
 *
 * Sentences synthesize CONCURRENTLY (up to elevenlabsHttpConcurrency in flight) so sentence
 * N+1's ~600ms model TTFB overlaps sentence N's streaming/playback — but audio is emitted
 * strictly in sentence order: every chunk lands in its job's buffer and `drain()` releases
 * buffers head-first, switching to live passthrough once a job becomes the head.
 *
 * Latency tradeoff vs Flash WS: first sound still waits for the LLM's first full sentence +
 * the model TTFB — expressiveness over speed, by design. (v3 rejects `previous_text`, so
 * cross-sentence prosody stitching is not available.)
 */

// Sentence boundary: terminal punctuation (incl. Devanagari danda) followed by whitespace.
const SENTENCE_END = /([.!?।…]["')\]]?)\s+/g;

interface SentenceJob {
  text: string;
  chunks: Buffer[]; // received but not yet released (only while not head)
  done: boolean;
}

export class ElevenLabsHttpTts implements TtsProvider {
  private buf = "";
  private jobs: SentenceJob[] = [];
  private head = 0; // first job whose audio hasn't fully been released
  private nextToLaunch = 0;
  private running = 0;
  private cancelled = false;
  private finished = false;
  private emittedAny = false;
  private readonly inFlight = new Set<AbortController>();
  private audioCb: (pcm16: Buffer) => void = () => {};
  private doneCb: () => void = () => {};
  private errorCb: (e: Error) => void = () => {};
  private readonly logc = log.child({ mod: "tts:eleven-http" });

  async connect(): Promise<void> {
    // No persistent connection; per-sentence HTTP requests (sockets pre-warmed elsewhere).
  }

  appendText(text: string): void {
    if (this.cancelled || this.finished || !text) return;
    this.buf += text;
    // Cut every complete sentence out of the buffer and queue it.
    let lastEnd = 0;
    SENTENCE_END.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE_END.exec(this.buf)) !== null) {
      lastEnd = m.index + m[1]!.length;
    }
    if (lastEnd > 0) {
      this.enqueue(this.buf.slice(0, lastEnd));
      this.buf = this.buf.slice(lastEnd).replace(/^\s+/, "");
    }
  }

  finish(): void {
    if (this.cancelled || this.finished) return;
    this.finished = true;
    if (this.buf.trim()) this.enqueue(this.buf);
    this.buf = "";
    this.maybeDone();
  }

  private enqueue(sentence: string): void {
    const s = sentence.trim();
    if (!s) return;
    this.jobs.push({ text: s, chunks: [], done: false });
    this.kick();
  }

  /** Launch synthesis for queued sentences up to the concurrency cap. */
  private kick(): void {
    while (this.running < config.elevenlabsHttpConcurrency && this.nextToLaunch < this.jobs.length) {
      const job = this.jobs[this.nextToLaunch++]!;
      this.running++;
      void this.synthesize(job).finally(() => {
        this.running--;
        this.drain();
        this.kick();
        this.maybeDone();
      });
    }
  }

  /** Release audio strictly in sentence order; live passthrough happens via drain() too. */
  private drain(): void {
    while (this.head < this.jobs.length) {
      const j = this.jobs[this.head]!;
      if (j.chunks.length) {
        if (!this.cancelled) {
          this.emittedAny = true;
          for (const c of j.chunks) this.audioCb(c);
        }
        j.chunks = [];
      }
      if (!j.done) break; // still streaming — stay on this head, future chunks drain as they land
      this.head++;
    }
  }

  private maybeDone(): void {
    if (this.finished && this.head >= this.jobs.length && this.running === 0 && !this.buf.trim()) {
      this.doneCb();
    }
  }

  private async synthesize(job: SentenceJob): Promise<void> {
    if (this.cancelled) {
      job.done = true;
      return;
    }
    const abort = new AbortController();
    this.inFlight.add(abort);
    let emittedBytes = 0;
    try {
      const url =
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenlabsVoiceId)}` +
        `/stream?output_format=pcm_${config.audioOutSampleRate}`;
      const body: Record<string, unknown> = { text: job.text, model_id: config.elevenlabsHttpTtsModel };
      if (config.elevenlabsTtsLanguage) body.language_code = config.elevenlabsTtsLanguage;
      const request = (): Promise<Response> =>
        fetch(url, {
          method: "POST",
          headers: { "xi-api-key": config.elevenlabsApiKey, "content-type": "application/json" },
          body: JSON.stringify(body),
          // Per-request ceiling: a hung stream must not pin the playback head forever.
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
        });
      let res = await request();
      if ((res.status === 429 || res.status >= 500) && !this.cancelled) {
        // One retry — 429 is the expected failure under our own synthesis concurrency.
        const retryAfter = Number(res.headers.get("retry-after")) || 0.6;
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 3) * 1000));
        res = await request();
      }
      if (!res.ok || !res.body) {
        throw new Error(`elevenlabs http tts ${res.status}: ${(await res.text()).slice(0, 160)}`);
      }
      for await (const chunk of res.body) {
        if (this.cancelled) break;
        const buf = Buffer.from(chunk);
        emittedBytes += buf.length;
        job.chunks.push(buf);
        this.drain();
      }
    } catch (e) {
      if (!this.cancelled) {
        this.logc.warn("sentence synth failed; skipping it", { error: String(e).slice(0, 160) });
        // Only a hard failure with zero audio so far is worth surfacing to the session.
        if (!this.emittedAny && this.head === 0) {
          this.errorCb(e instanceof Error ? e : new Error(String(e)));
        }
      }
    } finally {
      // A truncated stream can end on an odd byte; pad to a whole PCM16 sample so every
      // later sentence stays sample-aligned through the downstream framer.
      if (emittedBytes & 1) job.chunks.push(Buffer.alloc(1));
      this.inFlight.delete(abort);
      job.done = true;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.buf = "";
    for (const c of this.inFlight) {
      try {
        c.abort();
      } catch {
        /* ignore */
      }
    }
    this.inFlight.clear();
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
