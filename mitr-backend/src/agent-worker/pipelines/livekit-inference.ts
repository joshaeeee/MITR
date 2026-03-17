import { inference, voice } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import type { VoicePipelineStrategy } from './types.js';
import { SILERO_VAD_USERDATA_KEY } from './utils.js';

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
  async prewarm({ env, proc }) {
    if (env.AGENT_VOICE_PIPELINE !== 'livekit_inference') return;
    if (proc.userData[SILERO_VAD_USERDATA_KEY]) return;
    proc.userData[SILERO_VAD_USERDATA_KEY] = await silero.VAD.load({ minSilenceDuration: 250 });
  },
  validate({ env, ctx }) {
    if (!env.CARTESIA_VOICE_ID?.trim()) {
      throw new Error('CARTESIA_VOICE_ID is required when AGENT_VOICE_PIPELINE=livekit_inference');
    }
    if (!ctx.proc.userData[SILERO_VAD_USERDATA_KEY]) {
      throw new Error(
        'AGENT_VOICE_PIPELINE=livekit_inference requires a prewarmed Silero VAD model, but none was found.'
      );
    }
  },
  createSession({ env, language, ctx }) {
    const normalizedLanguage = normalizeInferenceLanguage(language);
    const prewarmedVad = ctx.proc.userData[SILERO_VAD_USERDATA_KEY] as silero.VAD | undefined;

    return new voice.AgentSession({
      turnDetection: 'stt',
      vad: prewarmedVad,
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
        minInterruptionDuration: 400,
        minInterruptionWords: 2,
        minEndpointingDelay: 200
      }
    });
  }
};
