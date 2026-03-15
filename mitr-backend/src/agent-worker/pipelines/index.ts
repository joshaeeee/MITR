import type { PipelineContext, PipelinePrewarmContext, VoicePipelineStrategy } from './types.js';
import { geminiRealtimeTextSarvamTtsPipeline } from './gemini-realtime-text-sarvam-tts.js';
import { livekitInferencePipeline } from './livekit-inference.js';
import { openAiRealtimePipeline } from './openai-realtime.js';
import { sarvamSttLlmCartesiaTtsPipeline } from './sarvam-stt-llm-cartesia-tts.js';
import { sarvamSttLlmTtsPipeline } from './sarvam-stt-llm-tts.js';

const PIPELINES: Record<VoicePipelineStrategy['id'], VoicePipelineStrategy> = {
  openai_realtime: openAiRealtimePipeline,
  sarvam_stt_llm_tts: sarvamSttLlmTtsPipeline,
  sarvam_stt_llm_cartesia_tts: sarvamSttLlmCartesiaTtsPipeline,
  gemini_realtime_text_sarvam_tts: geminiRealtimeTextSarvamTtsPipeline,
  livekit_inference: livekitInferencePipeline
};

export const getVoicePipeline = (
  pipelineId: VoicePipelineStrategy['id']
): VoicePipelineStrategy => PIPELINES[pipelineId];

export const prewarmVoicePipeline = async (input: PipelinePrewarmContext): Promise<void> => {
  const pipeline = getVoicePipeline(input.env.AGENT_VOICE_PIPELINE);
  await pipeline.prewarm?.(input);
};

export const validateVoicePipeline = (input: PipelineContext): void => {
  const pipeline = getVoicePipeline(input.env.AGENT_VOICE_PIPELINE);
  pipeline.validate(input);
};

export const createVoiceSession = (input: PipelineContext) => {
  const pipeline = getVoicePipeline(input.env.AGENT_VOICE_PIPELINE);
  return pipeline.createSession(input);
};
