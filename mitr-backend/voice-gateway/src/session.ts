import type { WebSocket } from "ws";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { DeviceAuthContext, LlmProvider, SttProvider, TranscriptEvent, TtsProvider } from "./types.js";
import { createLlm, createStt, createTts, providerLabel } from "./providers/index.js";
import { BackendToolBridge } from "./tools/bridge.js";
import { EnergyVad } from "./audio/vad.js";
import { WakeMatcher } from "./wake/matcher.js";
import { AudioPacer } from "./audio/pacer.js";
import { PcmFramer, applyGain } from "./audio/pcm.js";
import { TurnTimer, emitLatency } from "./latency.js";
import { sendAudioFrame, sendEvent } from "./state.js";
import { prewarmProviders } from "./prewarm.js";

const TTS_DRAIN_SAFETY_MS = 15000;

/**
 * Compare queries ignoring punctuation/casing/whitespace: an STT final often differs from
 * the partial we speculated on only by a trailing "।"/"." — that must still commit the spec
 * (a miss aborts a correct in-flight LLM run and pays full TTFT again).
 */
function normalizeQuery(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\p{P}\p{S}\p{C}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A speculative LLM run kicked off on a stable partial, before end-of-turn is confirmed. */
interface SpecRun {
  query: string;
  abort: AbortController;
  buffer: string[]; // LLM text produced before commit (the "head start")
  firstDeltaAt: number; // when the speculative LLM produced its first token
  llmDone: Promise<{ assistantText: string }>;
  // Speculative TTS (final-triggered specs only): synthesis runs during the hangover and
  // audio buffers here; released at commit, discarded on abort.
  tts: TtsProvider | null;
  ttsConnect: Promise<void> | null;
  audioChunks: Buffer[];
  ttsDoneFired: boolean;
  ttsFailed: boolean;
  llmFailed: boolean; // LLM died with NO output — commit must re-run fresh, not play silence
}

/**
 * Per-connection voice session orchestrator.
 *
 *   inbound PCM16 ─▶ [echo gate] ─▶ STT (always-on) + VAD endpointer
 *                                      │                 │
 *                          partial/final transcripts   speech_end ─▶ stt.flush()
 *
 * Turn-taking is server-side. To hit sub-1s, the LLM runs SPECULATIVELY on a stable
 * partial during the silence hangover; at end-of-turn we either commit it (TTFT already
 * paid) or abort and run fresh. Echo suppression is half-duplex (no AEC on device).
 */
export class Session {
  private readonly logc;
  private readonly sessionId: string;
  private readonly stt: SttProvider;
  private readonly llm: LlmProvider;
  private readonly vad: EnergyVad;
  private readonly wake: WakeMatcher;
  private readonly frameBytes: number;
  private readonly frameMs: number;

  private awake = false;
  private closed = false;
  private turnInProgress = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private muteUntil = 0; // echo suppression: drop inbound audio until this epoch-ms
  private lastWakePhrase = "";
  private lastPartialText = ""; // latest STT partial; endpointed by VAD speech_end
  // Finals accumulated within the current utterance. Saaras emits a final PER SEGMENT
  // (one per short pause) and few interims — committing only the last segment would drop
  // the first half of a query spoken with a mid-sentence pause.
  private pendingFinals: string[] = [];
  private awaitingFinalTurn = false; // speech_end fired but partial wasn't ready -> wait for committed final
  private greetingTimer: NodeJS.Timeout | null = null; // grace before answering a bare wake
  private wakeAtMs: number | undefined;
  private firstTurnAfterWake = false;
  private speechEndAtMs = 0;
  private turnIndex = 0;

  // speculation
  private spec: SpecRun | null = null;
  private specCheckTimer: NodeJS.Timeout | null = null;
  /** Single sink for LLM text deltas; reassigned per run (buffer while speculating, TTS once committed). */
  private deltaTarget: ((d: string) => void) | null = null;

  // per-turn output
  private currentTts: TtsProvider | null = null;
  private pacer: AudioPacer | null = null;
  private turnTimer: TurnTimer | null = null;
  private turnAbort: AbortController | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly auth: DeviceAuthContext,
  ) {
    this.sessionId = `voice-${auth.deviceId}`;
    this.logc = log.child({ mod: "session", deviceId: auth.deviceId });
    this.frameMs = config.audioPacketMs;
    this.frameBytes = Math.floor((config.audioOutSampleRate * this.frameMs) / 1000) * 2;

    const executor = new BackendToolBridge(auth, this.sessionId);
    this.llm = createLlm(auth, executor);
    this.llm.onTextDelta((delta) => this.deltaTarget?.(delta));
    this.llm.onToolStart((name) => {
      sendEvent(ws, { type: "tool_event", status: "start", name, deviceId: auth.deviceId });
      this.muteUntil = Math.max(this.muteUntil, Date.now() + config.toolInputSuppressionTailMs);
    });
    this.llm.onToolEnd((name, ok) => {
      sendEvent(ws, { type: "tool_event", status: ok ? "end" : "error", name, deviceId: auth.deviceId });
      if (this.turnTimer) {
        const marks = this.turnTimer as unknown as { marks: Record<string, number> };
        marks.marks.toolCount = (marks.marks.toolCount ?? 0) + 1;
      }
    });

    this.stt = createStt();
    this.stt.onTranscript((t) => this.onTranscript(t));
    this.stt.onError((e) => {
      this.logc.warn("stt error", { error: String(e) });
      sendEvent(ws, { type: "gateway_error", source: "stt", message: String(e), fatal: false, deviceId: auth.deviceId });
    });

    this.vad = new EnergyVad({
      sampleRate: config.audioInSampleRate,
      startRms: config.vadStartRms,
      stopRms: config.vadStopRms,
      startMs: config.vadStartMs,
      silenceMs: config.vadSilenceMs,
      maxUtteranceMs: config.vadMaxUtteranceMs,
    });
    this.wake = new WakeMatcher(config.wakePhrases);
  }

  async start(): Promise<void> {
    await this.stt.connect();
    sendEvent(this.ws, { type: "listening", wakePhrases: config.wakePhrases, deviceId: this.auth.deviceId });
    this.logc.info("session listening", { provider: providerLabel(), speculative: config.speculative });
  }

  // ---- inbound ----

  handleBinary(pcm: Buffer): void {
    if (this.closed || pcm.length === 0) return;
    if (config.echoSuppression && Date.now() < this.muteUntil) return; // half-duplex

    this.stt.sendAudio(pcm);

    if (!config.vadEnabled) return;
    const ev = this.vad.feed(pcm);
    if (ev) this.logc.debug("vad", { ev, awake: this.awake, turnInProgress: this.turnInProgress });
    if (ev === "speech_start") {
      prewarmProviders(); // a provider request follows within 1-4s; pay TLS now
      // New speech = new utterance epoch: a stale "waiting for final" flag from a
      // previous utterance (possibly while asleep) must not endpoint the first segment
      // of THIS utterance prematurely.
      this.awaitingFinalTurn = false;
      if (this.greetingTimer) {
        clearTimeout(this.greetingTimer); // the pause continued into more speech
        this.greetingTimer = null;
      }
      if (this.awake) this.resetIdle();
    } else if (ev === "speech_end") {
      this.speechEndAtMs = Date.now();
      this.stt.flush();
      if (this.awake && !this.turnInProgress) {
        // Prefer the accumulated finals (committed text); fall back to the live partial.
        const joined = this.pendingFinals.join(" ").replace(/\s+/g, " ").trim();
        const partial = this.lastPartialText.trim();
        const query = this.wake.stripLeadingWake(joined) || (partial ? this.wake.stripLeadingWake(partial) : "");
        if (query) {
          this.endpoint(query);
        } else if (joined) {
          // Only the wake phrase so far — grace window, not an instant greeting (the
          // user is likely pausing before the actual question).
          this.scheduleGreetingTurn();
        } else {
          this.awaitingFinalTurn = true; // wait for the committed final
        }
      } else if (!this.turnInProgress) {
        // Not awake yet — if the segment final lands AFTER this point and contains the
        // wake phrase, it must start the turn immediately rather than wait forever.
        this.awaitingFinalTurn = true;
      }
    }
  }

  handleText(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "hello") this.logc.debug("device hello", { ts: msg.ts });
  }

  private onTranscript(t: TranscriptEvent): void {
    if (this.closed) return;
    const text = t.text.trim();
    if (!text) return;
    this.logc.debug("transcript", {
      text: config.logTranscripts ? text : `<${text.length} chars>`,
      isFinal: t.isFinal,
      awake: this.awake,
    });
    this.lastPartialText = text;

    if (!t.isFinal) {
      if (!this.awake) {
        const matched = this.wake.feed(text);
        if (matched) this.goAwake(matched);
      } else {
        if (config.sendInterimTranscripts) {
          sendEvent(this.ws, { type: "transcript", status: "interim", text, deviceId: this.auth.deviceId });
        }
        this.scheduleSpeculation(text);
        this.resetIdle();
      }
      return;
    }

    // final / committed
    if (!this.awake) {
      const matched = this.wake.feed(text);
      if (!matched) return;
      this.goAwake(matched);
      // Fall through: this final is the FIRST SEGMENT of the utterance. The same
      // accumulate -> speculate -> VAD-commit path below handles every shape uniformly:
      // bare "Hi Mitr" greets at VAD end; "Hi Mitr <pause> question" accumulates both
      // segments into one query instead of answering the greeting over the question.
    }

    sendEvent(this.ws, { type: "transcript", status: "final", text, deviceId: this.auth.deviceId });
    if (!this.turnInProgress) {
      this.pendingFinals.push(text);
      if (this.awaitingFinalTurn || !config.vadEnabled) {
        const joined = this.pendingFinals.join(" ").replace(/\s+/g, " ").trim();
        const stripped = this.wake.stripLeadingWake(joined);
        if (stripped) {
          this.endpoint(stripped);
        } else if (joined) {
          // Bare wake phrase so far ("Hi Mitr <long pause>"). Don't answer the greeting
          // instantly — elders often pause before the actual question, and a greeting
          // reply would talk over it. Wait a short grace; new speech cancels it.
          this.scheduleGreetingTurn();
        }
      } else if (this.vad.trailingSilenceMs >= 100) {
        // Saaras's server-side VAD finalizes well before our energy-VAD hangover elapses.
        // A final is definitive text — speculate on it IMMEDIATELY (no stability wait), so
        // the LLM TTFT (and speculative TTS) burn during the remaining hangover instead of
        // after commit. Gate on actual mic silence: a final that lands while the user is
        // still voicing would waste a paid LLM + TTS run that immediately aborts. Skip
        // wake-greeting-only text — "Hi Mitr <pause>" usually continues into the real
        // query, so speculating on the bare greeting is a near-guaranteed wasted call.
        const joined = this.pendingFinals.join(" ").replace(/\s+/g, " ").trim();
        const query = this.wake.stripLeadingWake(joined);
        if (query) this.maybeSpeculate(query, true);
      }
    }
    this.resetIdle();
  }

  /** Answer a bare "Hi Mitr" only after a grace window with no follow-up speech. */
  private scheduleGreetingTurn(): void {
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    this.greetingTimer = setTimeout(() => {
      this.greetingTimer = null;
      if (this.closed || this.turnInProgress || !this.awake) return;
      const effective = this.accumulatedQuery();
      if (effective) this.endpoint(effective);
    }, 800);
  }

  /** Current utterance = all finals so far this turn, wake phrase stripped (or the bare
   * wake greeting when that's all there is). */
  private accumulatedQuery(): string {
    const joined = this.pendingFinals.join(" ").replace(/\s+/g, " ").trim();
    if (!joined) return "";
    return this.wake.stripLeadingWake(joined) || joined;
  }

  // ---- speculation ----

  /** After the latest partial has been stable for speculativeStableMs, speculate on it. */
  private scheduleSpeculation(text: string): void {
    if (!config.speculative || this.turnInProgress || !this.awake) return;
    if (this.specCheckTimer) clearTimeout(this.specCheckTimer);
    const snapshot = text;
    this.specCheckTimer = setTimeout(() => {
      this.specCheckTimer = null;
      if (this.closed || this.turnInProgress || !this.awake) return;
      if (this.lastPartialText !== snapshot) return; // changed since -> not stable
      const query = this.wake.stripLeadingWake(snapshot);
      this.maybeSpeculate(query);
    }, config.speculativeStableMs);
  }

  private looksComplete(query: string): boolean {
    if (query.length < config.speculativeMinChars) return false;
    return query.trim().split(/\s+/).length >= 2; // a couple words; stability is the real gate
  }

  private maybeSpeculate(query: string, fromFinal = false): void {
    if (!config.speculative || this.turnInProgress || !this.awake || !query) return;
    if (this.spec && normalizeQuery(this.spec.query) === normalizeQuery(query)) return; // already running
    // Finals are committed text — no completeness heuristic needed (a bare "हेलो।" final
    // would never pass the min-chars gate, yet it IS the whole query).
    if (!fromFinal && !this.looksComplete(query)) return;
    this.startSpeculation(query, fromFinal);
  }

  private startSpeculation(query: string, fromFinal = false): void {
    this.clearSpeculation(false);
    const abort = new AbortController();
    const spec: SpecRun = {
      query,
      abort,
      buffer: [],
      firstDeltaAt: 0,
      llmDone: Promise.resolve({ assistantText: "" }),
      tts: null,
      ttsConnect: null,
      audioChunks: [],
      ttsDoneFired: false,
      ttsFailed: false,
      llmFailed: false,
    };
    this.spec = spec;

    // Speculative TTS: only for final-triggered specs (high confidence the query is the
    // real one) — synthesis costs real money, so don't burn it on every shifting partial.
    if (config.speculativeTts && fromFinal) {
      const tts = createTts();
      spec.tts = tts;
      tts.onAudio((pcm) => {
        if (!abort.signal.aborted) spec.audioChunks.push(pcm);
      });
      tts.onDone(() => (spec.ttsDoneFired = true));
      tts.onError((e) => {
        spec.ttsFailed = true;
        this.logc.warn("speculative tts failed; will replay text at commit", { error: String(e).slice(0, 160) });
      });
      spec.ttsConnect = tts.connect().catch((e) => {
        spec.ttsFailed = true;
        this.logc.warn("speculative tts connect failed", { error: String(e).slice(0, 160) });
      });
    }

    this.deltaTarget = (d) => {
      if (!spec.firstDeltaAt) spec.firstDeltaAt = Date.now();
      spec.buffer.push(d);
      if (spec.tts && !spec.ttsFailed && !abort.signal.aborted) spec.tts.appendText(d);
    };
    this.logc.info("speculation start", {
      query: config.logTranscripts ? query : `<${query.length} chars>`,
      ttsSpeculative: !!spec.tts,
    });
    spec.llmDone = this.llm
      .runUserTurn(query, abort.signal)
      .catch((e) => {
        // A spec that produced nothing must not commit as a silent turn.
        if (spec.buffer.length === 0) spec.llmFailed = true;
        this.logc.debug("speculative llm ended", { error: String(e) });
        return { assistantText: spec.buffer.join("") };
      });
    // If the LLM completes while still speculating, finish the spec TTS so the tail
    // sentence also synthesizes during the hangover.
    void spec.llmDone.then(() => {
      if (this.spec === spec && spec.tts && !spec.ttsFailed && !abort.signal.aborted) spec.tts.finish();
    });
  }

  private clearSpeculation(clearTimer = true): void {
    if (clearTimer && this.specCheckTimer) {
      clearTimeout(this.specCheckTimer);
      this.specCheckTimer = null;
    }
    if (this.spec) {
      this.spec.abort.abort(); // rolls back its history in the provider
      if (this.spec.tts) void this.spec.tts.cancel().catch(() => {});
      this.spec = null;
    }
  }

  // ---- turn endpoint: commit the speculation or run fresh ----

  private endpoint(query: string): void {
    if (this.turnInProgress || !query) return;
    this.awaitingFinalTurn = false;
    this.pendingFinals = [];
    this.lastPartialText = "";
    if (this.greetingTimer) {
      clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
    if (this.specCheckTimer) {
      clearTimeout(this.specCheckTimer);
      this.specCheckTimer = null;
    }
    // Normalized compare: the committed final usually differs from the speculated text
    // only by punctuation ("।", ".") — that must NOT throw away a correct in-flight run.
    if (this.spec && normalizeQuery(this.spec.query) === normalizeQuery(query)) {
      const spec = this.spec;
      this.spec = null;
      void this.produceTurnOutput(query, spec);
    } else {
      this.clearSpeculation();
      void this.produceTurnOutput(query, null);
    }
  }

  /**
   * Produce the spoken response. If `spec` is provided, the LLM is already running
   * (TTFT paid during the hangover): flush its head-start tokens to TTS and keep
   * streaming. Otherwise run a fresh LLM turn.
   */
  private async produceTurnOutput(query: string, spec: SpecRun | null): Promise<void> {
    if (this.turnInProgress || this.closed) {
      if (spec) spec.abort.abort();
      return;
    }
    // A spec whose LLM died with no output would commit as a silent turn — discard it
    // and run fresh so the user gets an answer (or at least a surfaced error).
    if (spec?.llmFailed) {
      this.logc.warn("speculative llm failed with no output; running fresh");
      if (spec.tts) void spec.tts.cancel().catch(() => {});
      spec.abort.abort();
      spec = null;
    }
    this.turnInProgress = true;
    this.turnIndex += 1;
    const wakeAtForTurn = this.firstTurnAfterWake ? this.wakeAtMs : undefined;
    this.firstTurnAfterWake = false;

    const timer = new TurnTimer(
      this.auth.deviceId,
      this.sessionId,
      providerLabel(),
      this.turnIndex,
      this.lastWakePhrase,
      wakeAtForTurn,
    );
    timer.mark("speechEnd", this.speechEndAtMs || Date.now());
    timer.mark("sttFinal");
    if (spec && spec.firstDeltaAt) timer.mark("llmFirstDelta", spec.firstDeltaAt); // TTFT hidden behind hangover
    this.turnTimer = timer;
    this.logc.info("turn start", {
      turn: this.turnIndex,
      text: config.logTranscripts ? query : `<${query.length} chars>`,
      speculative: !!spec,
    });

    const abort = spec ? spec.abort : new AbortController();
    this.turnAbort = abort;

    // Reuse the speculative TTS (its audio is already synthesized/synthesizing) unless it
    // failed — then fall back to a fresh one and replay the buffered text through it.
    const specTtsUsable = !!(spec?.tts && !spec.ttsFailed);
    if (spec?.tts && !specTtsUsable) void spec.tts.cancel().catch(() => {}); // abort its in-flight requests
    const tts = specTtsUsable ? spec!.tts! : createTts();
    const framer = new PcmFramer(this.frameBytes);
    const pacer = new AudioPacer(
      (frame) => sendAudioFrame(this.ws, frame),
      this.frameMs,
      Math.max(this.frameMs * 2, 100),
      () => timer.mark("firstAudioOut"),
    );
    this.currentTts = tts;
    this.pacer = pacer;
    let resolveTtsDone: () => void = () => {};
    const ttsDone = new Promise<void>((r) => (resolveTtsDone = r));

    const emitAudio = (pcm: Buffer): void => {
      if (abort.signal.aborted) return;
      timer.mark("ttsFirstChunk");
      // Gain AFTER framing: HTTP TTS chunks arrive at arbitrary (possibly odd) byte
      // boundaries; per-chunk gain would pair bytes across samples and produce static.
      // Frames are always whole samples.
      for (const f of framer.push(pcm)) pacer.enqueue(applyGain(f, config.audioOutputGain));
      this.muteUntil = Math.max(this.muteUntil, pacer.playbackEndsAt + config.echoSuppressionTailMs);
    };
    tts.onAudio(emitAudio);
    tts.onDone(() => resolveTtsDone());
    tts.onError((e) => {
      this.logc.warn("tts error", { error: String(e) });
      resolveTtsDone();
    });

    // Release audio the speculative TTS already produced during the hangover.
    if (specTtsUsable && spec!.audioChunks.length) {
      for (const pcm of spec!.audioChunks) emitAudio(pcm);
      spec!.audioChunks = [];
    }
    if (specTtsUsable && spec!.ttsDoneFired) resolveTtsDone();

    // From now on, LLM deltas flow to TTS.
    this.deltaTarget = (d) => {
      timer.mark("llmFirstDelta");
      if (!abort.signal.aborted) tts.appendText(d);
    };

    let llmDone: Promise<{ assistantText: string }>;
    if (spec) {
      if (!specTtsUsable) {
        const headStart = spec.buffer.slice(); // tokens produced before commit
        for (const d of headStart) tts.appendText(d);
      }
      llmDone = spec.llmDone;
    } else {
      llmDone = this.llm.runUserTurn(query, abort.signal);
    }

    try {
      const connecting = (specTtsUsable ? spec!.ttsConnect ?? Promise.resolve() : tts.connect()).catch((e) => {
        this.logc.warn("tts connect failed", { error: String(e) });
        resolveTtsDone();
      });
      await llmDone;
      await connecting;
      tts.finish();
      let safetyTimer: NodeJS.Timeout | null = null;
      await Promise.race([
        ttsDone,
        new Promise<void>((r) => {
          safetyTimer = setTimeout(r, TTS_DRAIN_SAFETY_MS);
        }),
      ]);
      if (safetyTimer) clearTimeout(safetyTimer);
      // No audio may follow the `end` event: detach and cancel before flushing, so a
      // hung/late TTS stream can't interleave binary frames after the turn closed.
      tts.onAudio(() => {});
      void tts.cancel().catch(() => {});
      const rem = framer.flush();
      if (rem && rem.length) pacer.enqueue(applyGain(rem, config.audioOutputGain));
      this.muteUntil = Math.max(this.muteUntil, pacer.playbackEndsAt + config.echoSuppressionTailMs);
      await pacer.whenDrained();
      timer.mark("lastAudioOut");
      sendEvent(this.ws, { type: "end" });
    } catch (err) {
      this.logc.error("turn failed", { error: String(err) });
      // Stop everything still in flight: late TTS audio must not keep streaming to the
      // device after the turn already reported failure.
      abort.abort();
      tts.onAudio(() => {});
      void tts.cancel().catch(() => {});
      pacer.clear();
      sendEvent(this.ws, { type: "gateway_error", source: "turn", message: String(err), fatal: false, deviceId: this.auth.deviceId });
    } finally {
      emitLatency(timer.finalize());
      this.deltaTarget = null;
      this.currentTts = null;
      this.pacer = null;
      this.turnTimer = null;
      this.turnAbort = null;
      this.turnInProgress = false;
      // New turn epoch: drop any transcript state left from before/during this turn so a
      // late-arriving final can't leak into the NEXT query.
      this.pendingFinals = [];
      this.lastPartialText = "";
      if (this.awake) this.resetIdle();
    }
  }

  // ---- wake / idle state ----

  private goAwake(phrase: string): void {
    this.awake = true;
    prewarmProviders(); // the first turn's provider calls are seconds away
    this.wakeAtMs = Date.now();
    this.firstTurnAfterWake = true;
    this.lastWakePhrase = phrase;
    this.wake.reset();
    this.logc.info("awake", { wakePhrase: phrase });
    sendEvent(this.ws, { type: "awake", wakePhrase: phrase, idleTimeoutSec: config.wakeIdleTimeoutSec, deviceId: this.auth.deviceId });
    this.resetIdle();
  }

  private goSleep(reason: string): void {
    if (!this.awake) return;
    this.awake = false;
    this.wakeAtMs = undefined;
    this.lastPartialText = "";
    this.pendingFinals = [];
    this.awaitingFinalTurn = false;
    if (this.greetingTimer) {
      clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
    this.clearSpeculation();
    this.wake.reset();
    this.vad.reset();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.logc.info("sleeping", { reason });
    sendEvent(this.ws, { type: "sleeping", reason, deviceId: this.auth.deviceId });
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.goSleep("idle_timeout"), config.wakeIdleTimeoutSec * 1000);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.greetingTimer) clearTimeout(this.greetingTimer);
    this.clearSpeculation();
    if (this.turnAbort) this.turnAbort.abort();
    if (this.pacer) this.pacer.clear();
    if (this.currentTts) await this.currentTts.cancel().catch(() => {});
    await this.stt.close().catch(() => {});
    this.logc.info("session closed");
  }
}
