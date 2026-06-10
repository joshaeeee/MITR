import { config as loadEnv } from "dotenv";

loadEnv(); // load .env if present; real env always wins

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
function float(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(v.trim().toLowerCase());
}
function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function intList(name: string, fallback: number[]): number[] {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const parts = v
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return parts.length ? parts : fallback;
}

export type SttProviderName = "elevenlabs" | "sarvam";
export type TtsProviderName = "elevenlabs" | "eleven-v3" | "sarvam";
export type LlmProviderName = "claude" | "gemini" | "sarvam" | "echo";

const DEFAULT_WAKE_PHRASES = [
  "hi mitr", "hey mitr", "hi mitra", "hey mitra",
  "hi reca", "hey reca", "hi rekha", "hey rekha",
  "hi r e k a", "hey r e k a", "hi reka", "hey reka",
  "hi esp", "hey esp", "hi e s p",
  "हाय मित्र", "हे मित्र", "हाय रेका", "हाय रेखा",
];

export const config = {
  // ---- server ----
  // Default 7861 so it can run alongside the Pipecat gateway (7860) for A/B.
  host: str("MITR_GATEWAY_HOST", "127.0.0.1"), // bind all interfaces ONLY by explicit opt-in (prod behind nginx)
  port: int("MITR_GATEWAY_PORT", 7861),
  publicWsUrl: str("MITR_GATEWAY_PUBLIC_WS_URL", "ws://localhost:7861/ws"),
  protocol: "mitr-esp32-pcm16-v1",
  logLevel: str("LOG_LEVEL", "info").toLowerCase(),
  logTranscripts: bool("MITR_GATEWAY_LOG_TRANSCRIPTS", false),
  sendInterimTranscripts: bool("MITR_GATEWAY_SEND_INTERIM_TRANSCRIPTS", false),

  // ---- auth / backend ----
  authMode: str("MITR_GATEWAY_AUTH_MODE", "backend").toLowerCase(), // "backend" | "local"
  localDeviceId: str("MITR_GATEWAY_LOCAL_DEVICE_ID", ""),
  backendBaseUrl: str("MITR_BACKEND_BASE_URL", "").replace(/\/+$/, ""),
  backendInternalToken:
    str("MITR_BACKEND_INTERNAL_TOKEN") || str("INTERNAL_SERVICE_TOKEN"),
  corsOrigins: list("MITR_GATEWAY_CORS_ORIGINS", []),
  sessionTimeoutSec: int("MITR_GATEWAY_SESSION_TIMEOUT_SEC", 0), // 0 = no app-level timeout

  // ---- audio wire format (ESP32 contract) ----
  audioInSampleRate: int("ESP32_AUDIO_IN_SAMPLE_RATE", 16000),
  // ElevenLabs cascade is native pcm_16000 and the firmware hardcodes 16k playback.
  audioOutSampleRate: int("ESP32_AUDIO_OUT_SAMPLE_RATE", 16000),
  audioPacketMs: int("ESP32_AUDIO_PACKET_MS", 20),
  audioOutputGain: Math.max(0, Math.min(3, float("ESP32_AUDIO_OUTPUT_GAIN", 1.0))),

  // ---- provider selection ----
  sttProvider: str("MITR_GATEWAY_STT_PROVIDER", "elevenlabs") as SttProviderName,
  ttsProvider: str("MITR_GATEWAY_TTS_PROVIDER", "elevenlabs") as TtsProviderName,
  llmProvider: str("MITR_GATEWAY_LLM_PROVIDER", "claude") as LlmProviderName,

  // ---- wake phrase ----
  wakePhrases: list("MITR_GATEWAY_WAKE_PHRASES", DEFAULT_WAKE_PHRASES),
  wakeIdleTimeoutSec: float("MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC", 45),
  wakePrerollSec: float("MITR_GATEWAY_WAKE_PHRASE_PREROLL_SEC", 4),
  wakeUseInterimTranscripts: bool("MITR_GATEWAY_WAKE_USE_INTERIM_TRANSCRIPTS", true),

  // ---- VAD endpointer (firmware never sends an end-of-turn) ----
  vadEnabled: bool("MITR_GATEWAY_VAD_ENABLED", true),
  vadStartRms: int("MITR_GATEWAY_VAD_START_RMS", 700), // int16 RMS to enter speech
  vadStopRms: int("MITR_GATEWAY_VAD_STOP_RMS", 450), // int16 RMS below which counts as silence
  vadStartMs: int("MITR_GATEWAY_VAD_START_MS", 120), // sustained speech to confirm start
  vadSilenceMs: int("MITR_GATEWAY_VAD_SILENCE_MS", 400), // trailing silence => end of turn (350=floor, 250 over-fragments)
  vadMaxUtteranceMs: int("MITR_GATEWAY_VAD_MAX_UTTERANCE_MS", 20000),

  // ---- speculative endpointing (start the LLM on a stable partial during the hangover) ----
  speculative: bool("MITR_GATEWAY_SPECULATIVE", true),
  // Speculative TTS: synthesize the speculated reply during the VAD hangover and buffer the
  // audio; released at commit, discarded on abort. Only for final-transcript-triggered specs.
  speculativeTts: bool("MITR_GATEWAY_SPECULATIVE_TTS", true),
  speculativeStableMs: int("MITR_GATEWAY_SPECULATIVE_STABLE_MS", 80), // partial unchanged this long => speculate (low = earlier head start)
  speculativeMinChars: int("MITR_GATEWAY_SPECULATIVE_MIN_CHARS", 10),

  // ---- echo suppression (half-duplex; ESP32 has no AEC) ----
  echoSuppression: bool("MITR_GATEWAY_ECHO_SUPPRESSION", true),
  echoSuppressionTailMs: int("MITR_GATEWAY_ECHO_SUPPRESSION_TAIL_MS", 2500),
  toolInputSuppressionTailMs: int("MITR_GATEWAY_TOOL_INPUT_SUPPRESSION_TAIL_MS", 500),

  // ---- ElevenLabs STT (Scribe v2 realtime) ----
  elevenlabsApiKey: str("ELEVENLABS_API_KEY"),
  elevenlabsSttModel: str("ELEVENLABS_STT_MODEL", "scribe_v2_realtime"),
  elevenlabsSttLanguage: str("ELEVENLABS_STT_LANGUAGE", ""), // "" = auto-detect
  elevenlabsSttBaseUrl: str(
    "ELEVENLABS_STT_WS_URL",
    "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
  ),

  // ---- ElevenLabs TTS (Flash v2.5) ----
  elevenlabsVoiceId: str("ELEVENLABS_VOICE_ID") || str("ELEVENLABS_VOICE"),
  elevenlabsTtsModel: str("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5"),
  elevenlabsTtsLanguage: str("ELEVENLABS_TTS_LANGUAGE", ""),
  elevenlabsTtsBaseUrl: str("ELEVENLABS_TTS_WS_BASE", "wss://api.elevenlabs.io"),
  elevenlabsAutoMode: bool("ELEVENLABS_AUTO_MODE", true),
  elevenlabsChunkLengthSchedule: intList(
    "ELEVENLABS_CHUNK_LENGTH_SCHEDULE",
    [80, 160, 250, 290],
  ),
  // HTTP-streaming TTS for non-realtime models (provider "eleven-v3"): sentence-buffered.
  elevenlabsHttpTtsModel: str("ELEVENLABS_HTTP_TTS_MODEL", "eleven_v3"),
  // Sentence requests synthesized concurrently (audio still emitted strictly in order).
  elevenlabsHttpConcurrency: int("ELEVENLABS_HTTP_CONCURRENCY", 2),
  elevenlabsStability: float("ELEVENLABS_STABILITY", 0.5),
  elevenlabsSimilarityBoost: float("ELEVENLABS_SIMILARITY_BOOST", 0.8),
  elevenlabsStyle: float("ELEVENLABS_STYLE", 0.0),
  elevenlabsSpeed: float("ELEVENLABS_SPEED", 1.0),
  elevenlabsUseSpeakerBoost: bool("ELEVENLABS_USE_SPEAKER_BOOST", true),

  // ---- Sarvam (India-hosted: STT + LLM + TTS) ----
  sarvamApiKey: str("SARVAM_API_KEY"),
  // STT (Saaras streaming)
  sarvamSttModel: str("SARVAM_STT_MODEL", "saaras:v3"),
  sarvamSttWsUrl: str("SARVAM_STT_WS_URL", "wss://api.sarvam.ai/speech-to-text/ws"),
  sarvamSttLanguage: str("SARVAM_STT_LANGUAGE", "hi-IN"),
  sarvamSttMode: str("SARVAM_STT_MODE", "codemix"), // best for Hinglish
  // TTS (Bulbul streaming) — pcm/LINEAR16 @ sarvamTtsSampleRate, resampled to the device rate
  sarvamTtsModel: str("SARVAM_TTS_MODEL", "bulbul:v3"),
  sarvamTtsWsUrl: str("SARVAM_TTS_WS_URL", "wss://api.sarvam.ai/text-to-speech/ws"),
  sarvamTtsSpeaker: str("SARVAM_TTS_SPEAKER", "shubh"), // lowercase; Bulbul speaker ids are lowercase
  sarvamTtsLanguage: str("SARVAM_TTS_LANGUAGE", "hi-IN"),
  sarvamTtsSampleRate: int("SARVAM_TTS_SAMPLE_RATE", 22050), // SDK config default; we resample -> audioOut
  sarvamTtsPace: float("SARVAM_TTS_PACE", 1.0),
  // LLM (Sarvam-M, OpenAI-compatible)
  sarvamLlmBaseUrl: str("SARVAM_LLM_BASE_URL", "https://api.sarvam.ai/v1"),
  sarvamLlmModel: str("SARVAM_LLM_MODEL", "sarvam-30b"), // sarvam-m deprecated; sarvam-30b / sarvam-105b
  sarvamLlmMaxTokens: int("SARVAM_LLM_MAX_TOKENS", 512),
  sarvamLlmTemperature: float("SARVAM_LLM_TEMPERATURE", 0.7),
  sarvamLlmReasoning: str("SARVAM_LLM_REASONING", "off"), // "off" => reasoning_effort:null (lowest TTFT); else low|medium|high

  // ---- Claude LLM ----
  anthropicApiKey: str("ANTHROPIC_API_KEY"),
  claudeModel: str("CLAUDE_MODEL", "claude-sonnet-4-6"),
  claudeMaxTokens: int("CLAUDE_MAX_TOKENS", 512),
  claudeTemperature: float("CLAUDE_TEMPERATURE", 0.7),
  claudeSystemPromptPath: str("MITR_SYSTEM_PROMPT_PATH", ""), // "" => bundled default

  // ---- Gemini Flash LLM (low-latency text LLM; thinking disabled by default) ----
  geminiApiKey: str("GEMINI_API_KEY") || str("GOOGLE_API_KEY"),
  geminiModel: str("GEMINI_MODEL", "gemini-2.5-flash"),
  geminiMaxTokens: int("GEMINI_MAX_TOKENS", 512),
  geminiTemperature: float("GEMINI_TEMPERATURE", 0.7),
  geminiThinkingBudget: int("GEMINI_THINKING_BUDGET", 0), // 0 disables thinking => lowest TTFT

  // ---- tools ----
  toolsEnabled: bool("MITR_GATEWAY_TOOLS_ENABLED", true),
  backendToolTimeoutSec: int("MITR_GATEWAY_BACKEND_TOOL_TIMEOUT_SEC", 55),

  // ---- latency instrumentation ----
  latencyLog: bool("MITR_GATEWAY_LATENCY_LOG", true),
  latencyJsonlPath: str("MITR_GATEWAY_LATENCY_JSONL", ""), // optional file sink for benchmarks
} as const;

export type Config = typeof config;

const VALID_STT: readonly string[] = ["elevenlabs", "sarvam"];
const VALID_TTS: readonly string[] = ["elevenlabs", "eleven-v3", "sarvam"];
const VALID_LLM: readonly string[] = ["claude", "gemini", "sarvam", "echo"];
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** Validate config for the selected providers; throws with a clear message. */
export function validateConfig(): void {
  const errs: string[] = [];
  if (config.authMode === "backend" && !config.backendBaseUrl) {
    errs.push("MITR_BACKEND_BASE_URL is required when MITR_GATEWAY_AUTH_MODE != local");
  }
  // A typo'd provider must fail at boot, not crash the process on the first connection.
  if (!VALID_STT.includes(config.sttProvider)) {
    errs.push(`unknown MITR_GATEWAY_STT_PROVIDER "${config.sttProvider}" (valid: ${VALID_STT.join(", ")})`);
  }
  if (!VALID_TTS.includes(config.ttsProvider)) {
    errs.push(`unknown MITR_GATEWAY_TTS_PROVIDER "${config.ttsProvider}" (valid: ${VALID_TTS.join(", ")})`);
  }
  if (!VALID_LLM.includes(config.llmProvider)) {
    errs.push(`unknown MITR_GATEWAY_LLM_PROVIDER "${config.llmProvider}" (valid: ${VALID_LLM.join(", ")})`);
  }
  // Local auth trusts the caller-supplied deviceId. With no pinned device id that's an
  // OPEN gateway burning paid provider credits — only allow it on loopback.
  if (config.authMode === "local" && !config.localDeviceId && !LOOPBACK_HOSTS.includes(config.host)) {
    errs.push(
      "MITR_GATEWAY_AUTH_MODE=local with empty MITR_GATEWAY_LOCAL_DEVICE_ID is only allowed on a loopback host " +
        `(got MITR_GATEWAY_HOST=${config.host}); set a device id or use backend auth`,
    );
  }
  // Nonsense numeric env values hang the audio pipeline instead of erroring — reject at boot.
  if (config.audioPacketMs < 10 || config.audioPacketMs > 60) {
    errs.push(`ESP32_AUDIO_PACKET_MS must be 10-60 (got ${config.audioPacketMs}); the device expects 20ms/640B frames`);
  }
  if (config.elevenlabsHttpConcurrency < 1) {
    errs.push(`ELEVENLABS_HTTP_CONCURRENCY must be >= 1 (got ${config.elevenlabsHttpConcurrency})`);
  }
  if (config.vadSilenceMs <= 0) errs.push(`MITR_GATEWAY_VAD_SILENCE_MS must be > 0 (got ${config.vadSilenceMs})`);
  if (config.wakeIdleTimeoutSec <= 0) {
    errs.push(`MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC must be > 0 (got ${config.wakeIdleTimeoutSec})`);
  }
  if (config.backendToolTimeoutSec <= 0) {
    errs.push(`MITR_GATEWAY_BACKEND_TOOL_TIMEOUT_SEC must be > 0 (got ${config.backendToolTimeoutSec})`);
  }
  if (config.sttProvider === "elevenlabs" && !config.elevenlabsApiKey) {
    errs.push("ELEVENLABS_API_KEY is required for the ElevenLabs STT provider");
  }
  if (config.ttsProvider === "elevenlabs" || config.ttsProvider === "eleven-v3") {
    if (!config.elevenlabsApiKey) errs.push("ELEVENLABS_API_KEY is required for ElevenLabs TTS");
    if (!config.elevenlabsVoiceId) errs.push("ELEVENLABS_VOICE_ID is required for ElevenLabs TTS");
  }
  if (
    (config.sttProvider === "sarvam" || config.ttsProvider === "sarvam" || config.llmProvider === "sarvam") &&
    !config.sarvamApiKey
  ) {
    errs.push("SARVAM_API_KEY is required for the Sarvam provider");
  }
  if (config.llmProvider === "claude" && !config.anthropicApiKey) {
    errs.push("ANTHROPIC_API_KEY is required for the Claude LLM");
  }
  if (config.llmProvider === "gemini" && !config.geminiApiKey) {
    errs.push("GEMINI_API_KEY / GOOGLE_API_KEY is required for the Gemini LLM");
  }
  // "echo" needs no key (offline stub for smoke tests / audio-loop benchmarks).
  if (errs.length) {
    throw new Error("Invalid voice-gateway config:\n  - " + errs.join("\n  - "));
  }
}
