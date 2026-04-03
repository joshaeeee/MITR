import { Modality } from '@google/genai';
import { voice } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import type { VoicePipelineStrategy } from './types.js';
import { normalizeGoogleRealtimeModel, withDeviceVoiceOptions } from './utils.js';

export const geminiRealtimePipeline: VoicePipelineStrategy = {
  id: 'gemini_realtime',
  validate({ env }) {
    if (!env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY is required when AGENT_VOICE_PIPELINE=gemini_realtime');
    }
  },
  createSession({ env, isDeviceSession }) {
    const model = normalizeGoogleRealtimeModel(env.GOOGLE_REALTIME_MODEL);

    return new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        model,
        modalities: [Modality.AUDIO]
      }),
      voiceOptions: withDeviceVoiceOptions({
        maxToolSteps: 3,
        preemptiveGeneration: true,
        minInterruptionDuration: 600,
        minInterruptionWords: 2
      }, isDeviceSession)
    });
  }
};
