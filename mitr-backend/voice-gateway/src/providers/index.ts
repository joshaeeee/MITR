import { config } from "../config.js";
import type { DeviceAuthContext, LlmProvider, SttProvider, ToolExecutor, TtsProvider } from "../types.js";
import { SarvamStt } from "./stt-sarvam.js";
import { GeminiLlm } from "./llm-gemini.js";
import { ElevenLabsHttpTts } from "./tts-elevenlabs-http.js";

// Final production stack: Saaras v3 STT (India-hosted) -> Gemini 2.5 Flash -> Eleven v3.
// The provider interfaces (SttProvider/LlmProvider/TtsProvider in types.ts) stay pluggable;
// previous experimental adapters live in git history (PR #101's first commit).

export function createStt(): SttProvider {
  switch (config.sttProvider) {
    case "sarvam":
      return new SarvamStt();
    default:
      throw new Error(`unknown STT provider: ${config.sttProvider}`);
  }
}

export function createTts(): TtsProvider {
  switch (config.ttsProvider) {
    case "eleven-v3":
      return new ElevenLabsHttpTts();
    default:
      throw new Error(`unknown TTS provider: ${config.ttsProvider}`);
  }
}

export function createLlm(auth: DeviceAuthContext, executor: ToolExecutor): LlmProvider {
  switch (config.llmProvider) {
    case "gemini":
      return new GeminiLlm(auth, executor);
    default:
      throw new Error(`unknown LLM provider: ${config.llmProvider}`);
  }
}

export function providerLabel(): string {
  return `${config.sttProvider}+${config.llmProvider}+${config.ttsProvider}`;
}
