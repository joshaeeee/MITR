import { Modality } from '@google/genai';
import { voice } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as google from '@livekit/agents-plugin-google';
import type { VoicePipelineStrategy } from './types.js';
import { normalizeGoogleRealtimeModel } from './utils.js';

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

export const geminiRealtimeTextCartesiaTtsPipeline: VoicePipelineStrategy = {
  id: 'gemini_realtime_text_cartesia_tts',
  validate({ env }) {
    if (!env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is required when AGENT_VOICE_PIPELINE=gemini_realtime_text_cartesia_tts');
    }
    if (!env.CARTESIA_API_KEY) {
      throw new Error('CARTESIA_API_KEY is required when AGENT_VOICE_PIPELINE=gemini_realtime_text_cartesia_tts');
    }
  },
  createSession({ env, logger }) {
    const model = resolveGoogleRealtimeModel(env.GOOGLE_REALTIME_MODEL, logger);

    return new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        model,
        modalities: [Modality.TEXT]
      }),
      tts: new cartesia.TTS({
        model: env.CARTESIA_MODEL,
        voice: env.CARTESIA_VOICE_ID,
        language: env.CARTESIA_LANGUAGE,
        apiKey: env.CARTESIA_API_KEY,
        baseUrl: env.CARTESIA_BASE_URL,
        chunkTimeout: env.CARTESIA_CHUNK_TIMEOUT_MS
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
