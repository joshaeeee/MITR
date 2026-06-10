import { config } from "../config.js";
import type { DeviceAuthContext, LlmProvider, SttProvider, ToolExecutor, TtsProvider } from "../types.js";
import { ElevenLabsStt } from "./stt-elevenlabs.js";
import { ElevenLabsTts } from "./tts-elevenlabs.js";
import { ElevenLabsHttpTts } from "./tts-elevenlabs-http.js";
import { SarvamStt } from "./stt-sarvam.js";
import { SarvamTts } from "./tts-sarvam.js";
import { SarvamLlm } from "./llm-sarvam.js";
import { ClaudeLlm } from "./llm-claude.js";
import { GeminiLlm } from "./llm-gemini.js";
import { EchoLlm } from "./llm-echo.js";

export function createStt(): SttProvider {
  switch (config.sttProvider) {
    case "elevenlabs":
      return new ElevenLabsStt();
    case "sarvam":
      return new SarvamStt();
    default:
      throw new Error(`unknown STT provider: ${config.sttProvider}`);
  }
}

export function createTts(): TtsProvider {
  switch (config.ttsProvider) {
    case "elevenlabs":
      return new ElevenLabsTts();
    case "eleven-v3":
      return new ElevenLabsHttpTts();
    case "sarvam":
      return new SarvamTts();
    default:
      throw new Error(`unknown TTS provider: ${config.ttsProvider}`);
  }
}

export function createLlm(auth: DeviceAuthContext, executor: ToolExecutor): LlmProvider {
  switch (config.llmProvider) {
    case "claude":
      return new ClaudeLlm(auth, executor);
    case "gemini":
      return new GeminiLlm(auth, executor);
    case "sarvam":
      return new SarvamLlm(auth, executor);
    case "echo":
      return new EchoLlm();
    default:
      throw new Error(`unknown LLM provider: ${config.llmProvider}`);
  }
}

export function providerLabel(): string {
  return `${config.sttProvider}+${config.llmProvider}+${config.ttsProvider}`;
}
