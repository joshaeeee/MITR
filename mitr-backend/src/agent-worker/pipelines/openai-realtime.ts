import { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import type { VoicePipelineStrategy } from './types.js';

export const openAiRealtimePipeline: VoicePipelineStrategy = {
  id: 'openai_realtime',
  validate({ env }) {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for mitr-agent-worker');
    }
  },
  createSession({ env }) {
    return new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: env.OPENAI_REALTIME_MODEL,
        voice: env.OPENAI_REALTIME_VOICE,
        modalities: ['text', 'audio']
      }),
      voiceOptions: {
        maxToolSteps: 3,
        preemptiveGeneration: true,
        minInterruptionDuration: 600,
        minInterruptionWords: 2
      }
    });
  }
};
