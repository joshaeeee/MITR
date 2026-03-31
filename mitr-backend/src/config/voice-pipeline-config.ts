import type * as sarvam from '@livekit/agents-plugin-sarvam';
import type { Env } from './env.js';

export type VoicePipelineId = Env['AGENT_VOICE_PIPELINE'];

export interface OpenAiRealtimeConfig {
  apiKey?: string;
  model: string;
  voice: string;
}

export interface OpenRouterConfig {
  apiKey?: string;
  model: string;
  baseUrl: string;
}

export interface SarvamSpeechConfig {
  apiKey?: string;
  sttModel: sarvam.STTModels;
  sttMode: sarvam.STTModes;
  sttStreaming: boolean;
  ttsModel: string;
  ttsSpeaker: string;
  ttsStreaming: boolean;
}

export interface GoogleRealtimeConfig {
  apiKey?: string;
  model: string;
}

export interface CartesiaConfig {
  apiKey?: string;
  model: string;
  voiceId: string;
  language: string;
  baseUrl: string;
  chunkTimeoutMs: number;
}

export interface InferenceConfig {
  sttModel: string;
  llmModel: string;
  ttsModel: string;
}

export const getSelectedVoicePipeline = (env: Env): VoicePipelineId => env.AGENT_VOICE_PIPELINE;

export const isSelectedVoicePipeline = (env: Env, pipelineId: VoicePipelineId): boolean =>
  getSelectedVoicePipeline(env) === pipelineId;

export const getOpenAiRealtimeConfig = (env: Env): OpenAiRealtimeConfig => ({
  apiKey: env.OPENAI_API_KEY,
  model: env.OPENAI_REALTIME_MODEL,
  voice: env.OPENAI_REALTIME_VOICE
});

export const getOpenRouterConfig = (env: Env): OpenRouterConfig => ({
  apiKey: env.OPENROUTER_API_KEY,
  model: env.OPENROUTER_MODEL,
  baseUrl: env.OPENROUTER_BASE_URL
});

export const getSarvamSpeechConfig = (env: Env): SarvamSpeechConfig => ({
  apiKey: env.SARVAM_API_KEY,
  sttModel: env.SARVAM_STT_MODEL as sarvam.STTModels,
  sttMode: env.SARVAM_STT_MODE as sarvam.STTModes,
  sttStreaming: env.SARVAM_STT_STREAMING,
  ttsModel: env.SARVAM_TTS_MODEL,
  ttsSpeaker: env.SARVAM_TTS_SPEAKER,
  ttsStreaming: env.SARVAM_TTS_STREAMING
});

export const getGoogleRealtimeConfig = (env: Env): GoogleRealtimeConfig => ({
  apiKey: env.GOOGLE_API_KEY,
  model: env.GOOGLE_REALTIME_MODEL
});

export const getCartesiaConfig = (env: Env): CartesiaConfig => ({
  apiKey: env.CARTESIA_API_KEY,
  model: env.CARTESIA_MODEL,
  voiceId: env.CARTESIA_VOICE_ID,
  language: env.CARTESIA_LANGUAGE,
  baseUrl: env.CARTESIA_BASE_URL,
  chunkTimeoutMs: env.CARTESIA_CHUNK_TIMEOUT_MS
});

export const getInferenceConfig = (env: Env): InferenceConfig => ({
  sttModel: env.INFERENCE_STT_MODEL,
  llmModel: env.INFERENCE_LLM_MODEL,
  ttsModel: env.INFERENCE_TTS_MODEL
});
