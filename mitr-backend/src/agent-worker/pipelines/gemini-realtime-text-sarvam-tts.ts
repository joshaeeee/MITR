import { Modality } from '@google/genai';
import { voice } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import { getGoogleRealtimeConfig, getSarvamSpeechConfig } from '../../config/voice-pipeline-config.js';
import type { VoicePipelineStrategy } from './types.js';
import {
  normalizeGoogleRealtimeModel,
  normalizeSarvamTtsLanguageCode,
  normalizeSarvamTtsSpeaker,
  normalizeSarvamTtsModel,
  withDeviceVoiceOptions
} from './utils.js';

const resolveGoogleRealtimeModel = (
  configuredModel: string,
  logger: { warn: (message: string, meta?: unknown) => void }
): string => {
  const normalized = normalizeGoogleRealtimeModel(configuredModel);
  const fallback =
    normalized.toLowerCase().includes('native-audio') ? 'gemini-2.0-flash-exp' : normalized;

  if (normalized.toLowerCase().includes('native-audio')) {
    logger.warn('GOOGLE_REALTIME_MODEL is native-audio in half-cascade mode; falling back to non-native model', {
      configuredModel: normalized,
      fallbackModel: fallback
    });
  }

  if (normalized !== configuredModel) {
    logger.warn('Normalized GOOGLE_REALTIME_MODEL by stripping unsupported provider prefix', {
      configuredModel,
      normalizedModel: normalized
    });
  }

  return fallback;
};

export const geminiRealtimeTextSarvamTtsPipeline: VoicePipelineStrategy = {
  id: 'gemini_realtime_text_sarvam_tts',
  validate({ env }) {
    const googleConfig = getGoogleRealtimeConfig(env);
    const sarvamConfig = getSarvamSpeechConfig(env);
    if (!googleConfig.apiKey) {
      throw new Error('GOOGLE_API_KEY is required when AGENT_VOICE_PIPELINE=gemini_realtime_text_sarvam_tts');
    }
    if (!sarvamConfig.apiKey) {
      throw new Error('SARVAM_API_KEY is required when AGENT_VOICE_PIPELINE=gemini_realtime_text_sarvam_tts');
    }
  },
  createSession({ env, logger, language, isDeviceSession }) {
    const googleConfig = getGoogleRealtimeConfig(env);
    const sarvamConfig = getSarvamSpeechConfig(env);
    const model = resolveGoogleRealtimeModel(googleConfig.model, logger);
    const ttsModel = normalizeSarvamTtsModel(sarvamConfig.ttsModel, logger);
    const ttsSpeaker = normalizeSarvamTtsSpeaker(ttsModel, sarvamConfig.ttsSpeaker, logger);

    return new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        model,
        modalities: [Modality.TEXT]
      }),
      tts: new sarvam.TTS({
        model: ttsModel,
        speaker: ttsSpeaker,
        targetLanguageCode: normalizeSarvamTtsLanguageCode(language, logger),
        streaming: sarvamConfig.ttsStreaming
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
