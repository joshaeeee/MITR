import { inference, voice } from '@livekit/agents';
import type { VoicePipelineStrategy } from './types.js';

const normalizeInferenceLanguage = (language: string): string => {
  const trimmed = language.trim();
  if (!trimmed) return 'hi';
  const normalized = trimmed.replace('_', '-').toLowerCase();
  const base = normalized.split('-')[0];
  if (!base || base.length !== 2) return 'hi';
  return base;
};

export const livekitInferencePipeline: VoicePipelineStrategy = {
  id: 'livekit_inference',
  validate({ env }) {
    if (!env.CARTESIA_VOICE_ID?.trim()) {
      throw new Error('CARTESIA_VOICE_ID is required when AGENT_VOICE_PIPELINE=livekit_inference');
    }
  },
  createSession({ env, language }) {
    const normalizedLanguage = normalizeInferenceLanguage(language);

    return new voice.AgentSession({
      turnDetection: 'stt',
      stt: new inference.STT({
        model: env.INFERENCE_STT_MODEL,
        language: normalizedLanguage
      }),
      llm: new inference.LLM({
        model: env.INFERENCE_LLM_MODEL
      }),
      tts: new inference.TTS({
        model: env.INFERENCE_TTS_MODEL,
        voice: env.CARTESIA_VOICE_ID,
        language: normalizedLanguage
      }),
      voiceOptions: {
        maxToolSteps: 3,
        preemptiveGeneration: true,
        minInterruptionDuration: 0.6,
        minInterruptionWords: 2
      }
    });
  }
};
