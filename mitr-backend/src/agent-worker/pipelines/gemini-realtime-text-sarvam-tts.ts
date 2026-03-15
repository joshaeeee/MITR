import { Modality } from '@google/genai';
import { voice } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import type { VoicePipelineStrategy } from './types.js';
import {
  normalizeGoogleRealtimeModel,
  normalizeSarvamTtsLanguageCode,
  normalizeSarvamTtsSpeaker,
  normalizeSarvamTtsModel
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
    if (!env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is required when AGENT_VOICE_PIPELINE=gemini_realtime_text_sarvam_tts');
    }
    if (!env.SARVAM_API_KEY) {
      throw new Error('SARVAM_API_KEY is required when AGENT_VOICE_PIPELINE=gemini_realtime_text_sarvam_tts');
    }
  },
  createSession({ env, logger, language }) {
    const model = resolveGoogleRealtimeModel(env.GOOGLE_REALTIME_MODEL, logger);
    const ttsModel = normalizeSarvamTtsModel(env.SARVAM_TTS_MODEL, logger);
    const ttsSpeaker = normalizeSarvamTtsSpeaker(ttsModel, env.SARVAM_TTS_SPEAKER, logger);

    return new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        model,
        modalities: [Modality.TEXT]
      }),
      tts: new sarvam.TTS({
        model: ttsModel,
        speaker: ttsSpeaker,
        targetLanguageCode: normalizeSarvamTtsLanguageCode(language, logger),
        streaming: env.SARVAM_TTS_STREAMING
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
