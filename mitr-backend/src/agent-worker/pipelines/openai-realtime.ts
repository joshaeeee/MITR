import { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { getOpenAiRealtimeConfig } from '../../config/voice-pipeline-config.js';
import type { VoicePipelineStrategy } from './types.js';

export const openAiRealtimePipeline: VoicePipelineStrategy = {
  id: 'openai_realtime',
  validate({ env }) {
    const config = getOpenAiRealtimeConfig(env);
    if (!config.apiKey) {
      throw new Error('OPENAI_API_KEY is required for mitr-agent-worker');
    }
  },
  createSession({ env }) {
    const config = getOpenAiRealtimeConfig(env);
    return new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: config.model,
        voice: config.voice,
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
