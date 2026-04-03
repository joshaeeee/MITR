import { inference, voice } from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import {
  getCartesiaConfig,
  getInferenceConfig,
  isSelectedVoicePipeline
} from '../../config/voice-pipeline-config.js';
import type { VoicePipelineStrategy } from './types.js';
import { SILERO_VAD_USERDATA_KEY, withDeviceVoiceOptions } from './utils.js';

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
    if (!isSelectedVoicePipeline(env, 'livekit_inference')) return;
    if (proc.userData[SILERO_VAD_USERDATA_KEY]) return;
    proc.userData[SILERO_VAD_USERDATA_KEY] = await silero.VAD.load({ minSilenceDuration: 250 });
  },
  validate({ env, ctx }) {
    const cartesiaConfig = getCartesiaConfig(env);
    if (!cartesiaConfig.voiceId.trim()) {
      throw new Error('CARTESIA_VOICE_ID is required when AGENT_VOICE_PIPELINE=livekit_inference');
    }
    if (!ctx.proc.userData[SILERO_VAD_USERDATA_KEY]) {
      throw new Error(
        'AGENT_VOICE_PIPELINE=livekit_inference requires a prewarmed Silero VAD model, but none was found.'
      );
    }
  },
  createSession({ env, language, ctx, isDeviceSession }) {
    const inferenceConfig = getInferenceConfig(env);
    const cartesiaConfig = getCartesiaConfig(env);
    const normalizedLanguage = normalizeInferenceLanguage(language);
    const prewarmedVad = ctx.proc.userData[SILERO_VAD_USERDATA_KEY] as silero.VAD | undefined;

    return new voice.AgentSession({
      turnDetection: 'stt',
      vad: prewarmedVad,
      stt: new inference.STT({
        model: inferenceConfig.sttModel,
        language: normalizedLanguage
      }),
      llm: new inference.LLM({
        model: inferenceConfig.llmModel
      }),
      tts: new inference.TTS({
        model: inferenceConfig.ttsModel,
        voice: cartesiaConfig.voiceId,
        language: normalizedLanguage
      }),
      voiceOptions: withDeviceVoiceOptions({
        maxToolSteps: 3,
        preemptiveGeneration: true,
        minInterruptionDuration: 400,
        minInterruptionWords: 2,
        minEndpointingDelay: 200
      }, isDeviceSession)
    });
  }
};
