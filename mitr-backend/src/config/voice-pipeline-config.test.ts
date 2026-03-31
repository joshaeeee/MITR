import test from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from './env.js';
import {
  getCartesiaConfig,
  getInferenceConfig,
  getOpenAiRealtimeConfig,
  getOpenRouterConfig,
  getSarvamSpeechConfig,
  getSelectedVoicePipeline,
  isSelectedVoicePipeline
} from './voice-pipeline-config.js';

const buildEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    AGENT_VOICE_PIPELINE: 'sarvam_stt_llm_cartesia_tts',
    OPENAI_API_KEY: 'openai-key',
    OPENAI_REALTIME_MODEL: 'gpt-realtime',
    OPENAI_REALTIME_VOICE: 'alloy',
    OPENROUTER_API_KEY: 'openrouter-key',
    OPENROUTER_MODEL: 'openai/gpt-4o-mini',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    SARVAM_API_KEY: 'sarvam-key',
    SARVAM_STT_MODEL: 'saaras:v3',
    SARVAM_STT_MODE: 'transcribe',
    SARVAM_STT_STREAMING: true,
    SARVAM_TTS_MODEL: 'bulbul:v3',
    SARVAM_TTS_SPEAKER: 'shubh',
    SARVAM_TTS_STREAMING: true,
    GOOGLE_API_KEY: 'google-key',
    GOOGLE_REALTIME_MODEL: 'gemini-2.0-flash-exp',
    CARTESIA_API_KEY: 'cartesia-key',
    CARTESIA_MODEL: 'sonic-3',
    CARTESIA_VOICE_ID: 'voice-id',
    CARTESIA_LANGUAGE: 'hi',
    CARTESIA_BASE_URL: 'https://api.cartesia.ai',
    CARTESIA_CHUNK_TIMEOUT_MS: 500,
    INFERENCE_STT_MODEL: 'deepgram/nova-3-general',
    INFERENCE_LLM_MODEL: 'openai/gpt-4o-mini',
    INFERENCE_TTS_MODEL: 'cartesia/sonic-3',
    ...overrides
  }) as Env;

test('voice pipeline config helpers return focused provider slices', () => {
  const env = buildEnv();

  assert.equal(getSelectedVoicePipeline(env), 'sarvam_stt_llm_cartesia_tts');
  assert.equal(isSelectedVoicePipeline(env, 'sarvam_stt_llm_cartesia_tts'), true);
  assert.equal(isSelectedVoicePipeline(env, 'openai_realtime'), false);

  assert.deepEqual(getOpenAiRealtimeConfig(env), {
    apiKey: 'openai-key',
    model: 'gpt-realtime',
    voice: 'alloy'
  });

  assert.deepEqual(getOpenRouterConfig(env), {
    apiKey: 'openrouter-key',
    model: 'openai/gpt-4o-mini',
    baseUrl: 'https://openrouter.ai/api/v1'
  });

  assert.deepEqual(getSarvamSpeechConfig(env), {
    apiKey: 'sarvam-key',
    sttModel: 'saaras:v3',
    sttMode: 'transcribe',
    sttStreaming: true,
    ttsModel: 'bulbul:v3',
    ttsSpeaker: 'shubh',
    ttsStreaming: true
  });

  assert.deepEqual(getCartesiaConfig(env), {
    apiKey: 'cartesia-key',
    model: 'sonic-3',
    voiceId: 'voice-id',
    language: 'hi',
    baseUrl: 'https://api.cartesia.ai',
    chunkTimeoutMs: 500
  });

  assert.deepEqual(getInferenceConfig(env), {
    sttModel: 'deepgram/nova-3-general',
    llmModel: 'openai/gpt-4o-mini',
    ttsModel: 'cartesia/sonic-3'
  });
});
