// Shared contracts for the voice gateway. Providers (STT/TTS/LLM) implement these
// interfaces so the session orchestrator stays provider-agnostic.

/** Resolved per-connection device identity (from backend auth or local mode). */
export interface DeviceAuthContext {
  deviceId: string;
  userId?: string | null;
  userName?: string | null;
  familyId?: string | null;
  elderId?: string | null;
  elderName?: string | null;
  language: string; // BCP-ish tag, e.g. "hi-IN"
  timezone?: string | null;
}

/** A transcript update from an STT provider. */
export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
}

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------
export interface SttProvider {
  /** Open the upstream connection. Resolves once ready to accept audio. */
  connect(): Promise<void>;
  /** Push a chunk of 16 kHz mono PCM16 LE audio. Non-blocking. */
  sendAudio(pcm16: Buffer): void;
  /** Hint that the current utterance ended (request a final). Optional. */
  flush(): void;
  /** Close the upstream connection. */
  close(): Promise<void>;
  onTranscript(cb: (t: TranscriptEvent) => void): void;
  onError(cb: (e: Error) => void): void;
  onReady(cb: () => void): void;
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------
export interface TtsProvider {
  /** Open the upstream connection for a single spoken response. */
  connect(): Promise<void>;
  /** Append text as it streams from the LLM. */
  appendText(text: string): void;
  /** Signal no more text will arrive; provider flushes remaining audio then onDone. */
  finish(): void;
  /** Barge-in / hard stop: stop producing audio immediately and tear down. */
  cancel(): Promise<void>;
  /** Emits 16 kHz mono PCM16 LE chunks (gateway frames them to <=640B). */
  onAudio(cb: (pcm16: Buffer) => void): void;
  onDone(cb: () => void): void;
  onError(cb: (e: Error) => void): void;
}

// ---------------------------------------------------------------------------
// Tools (Anthropic tool-use shape; bridged to the mitr-backend)
// ---------------------------------------------------------------------------
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

export interface ToolExecutor {
  /** Tool schemas surfaced to the model (descriptions are behaviorally binding). */
  schemas(): AnthropicTool[];
  /** Execute a tool by name; returns a JSON-serializable result for the model. */
  execute(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// LLM (turn-based, owns conversation history for the session)
// ---------------------------------------------------------------------------
export interface LlmProvider {
  /**
   * Run one user turn through the full tool loop. Streams assistant spoken text
   * via onTextDelta as it is produced. Resolves when the turn is complete.
   * Honors `signal` for barge-in cancellation.
   */
  runUserTurn(userText: string, signal: AbortSignal): Promise<{ assistantText: string }>;
  onTextDelta(cb: (text: string) => void): void;
  onToolStart(cb: (name: string) => void): void;
  onToolEnd(cb: (name: string, ok: boolean) => void): void;
  /** Clear conversation history (new session / reset). */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Wire control events (gateway -> device/web). Firmware ignores most; web sim
// and benchmark client consume them.
// ---------------------------------------------------------------------------
export type ServerEvent =
  | { type: "ready"; protocol: string; audioIn: { sampleRate: number }; audioOut: { sampleRate: number }; deviceId: string }
  | { type: "listening"; wakePhrases: string[]; deviceId?: string }
  | { type: "awake"; wakePhrase: string; idleTimeoutSec: number; deviceId?: string }
  | { type: "sleeping"; reason: string; deviceId?: string }
  | { type: "transcript"; status: "interim" | "final"; text: string; deviceId?: string }
  | { type: "tool_event"; status: "start" | "end" | "error"; name: string; deviceId?: string }
  | { type: "interrupt" }
  | { type: "end" }
  | { type: "gateway_error"; source: string; message: string; fatal: boolean; deviceId?: string }
  | { type: "session_superseded"; deviceId?: string }
  | { type: "latency"; [k: string]: unknown };

/** Per-turn latency record (all ms; absent fields = not measured this turn). */
export interface LatencyTurn {
  deviceId: string;
  sessionId: string;
  turnIndex: number;
  provider: string; // e.g. "elevenlabs+claude+elevenlabs"
  wakePhrase?: string;
  /** wake-phrase detected -> first audio byte sent to device. */
  wakeToFirstAudioMs?: number;
  /** user end-of-speech (VAD) -> STT final transcript. */
  sttFinalizeMs?: number;
  /** STT final -> first LLM text delta. */
  llmTtftMs?: number;
  /** first LLM text delta -> first TTS audio chunk. */
  ttsFirstChunkMs?: number;
  /** user end-of-speech -> first audio byte sent to device (the headline number). */
  userFinalToFirstAudioMs?: number;
  /** user end-of-speech -> last audio byte sent (full response duration). */
  turnTotalMs?: number;
  toolCount?: number;
  toolTotalMs?: number;
  ts: string;
}
