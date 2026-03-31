import { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as silero from '@livekit/agents-plugin-silero';
import {
  getOpenRouterConfig,
  getSarvamSpeechConfig,
  isSelectedVoicePipeline
} from '../../config/voice-pipeline-config.js';
import type { VoicePipelineStrategy } from './types.js';
import {
  normalizeSarvamLanguageCode,
  normalizeSarvamTtsLanguageCode,
  normalizeSarvamTtsSpeaker,
  normalizeSarvamTtsModel,
  SILERO_VAD_USERDATA_KEY
} from './utils.js';

export const sarvamSttLlmTtsPipeline: VoicePipelineStrategy = {
  id: 'sarvam_stt_llm_tts',
  async prewarm({ env, proc }) {
    if (!isSelectedVoicePipeline(env, 'sarvam_stt_llm_tts')) return;
    if (proc.userData[SILERO_VAD_USERDATA_KEY]) return;
    // Reduce silence threshold from default 550ms → 400ms: fires END_OF_SPEECH sooner,
    // cutting ~150ms off every turn in vad turn-detection mode.
    proc.userData[SILERO_VAD_USERDATA_KEY] = await silero.VAD.load({ minSilenceDuration: 250 });
  },
  validate({ env, ctx }) {
    const openRouter = getOpenRouterConfig(env);
    const sarvamConfig = getSarvamSpeechConfig(env);
    if (!openRouter.apiKey) {
      throw new Error('OPENROUTER_API_KEY is required when AGENT_VOICE_PIPELINE=sarvam_stt_llm_tts');
    }
    if (!sarvamConfig.apiKey) {
      throw new Error('SARVAM_API_KEY is required when AGENT_VOICE_PIPELINE=sarvam_stt_llm_tts');
    }
    if (!ctx.proc.userData[SILERO_VAD_USERDATA_KEY]) {
      throw new Error(
        'AGENT_VOICE_PIPELINE=sarvam_stt_llm_tts requires a prewarmed Silero VAD model, but none was found.'
      );
    }
  },
  createSession({ env, logger, language, ctx }) {
    const openRouter = getOpenRouterConfig(env);
    const sarvamConfig = getSarvamSpeechConfig(env);
    const ttsModel = normalizeSarvamTtsModel(sarvamConfig.ttsModel, logger);
    const ttsSpeaker = normalizeSarvamTtsSpeaker(ttsModel, sarvamConfig.ttsSpeaker, logger);
    const sarvamNonStreamingStt = !sarvamConfig.sttStreaming;
    const prewarmedVad = ctx.proc.userData[SILERO_VAD_USERDATA_KEY] as silero.VAD | undefined;

    return new voice.AgentSession({
      turnDetection: sarvamNonStreamingStt ? 'vad' : 'stt',
      vad: prewarmedVad,
      stt: new sarvam.STT({
        model: sarvamConfig.sttModel,
        languageCode: normalizeSarvamLanguageCode(language),
        mode: sarvamConfig.sttMode,
        streaming: sarvamConfig.sttStreaming
      }),
      llm: new openai.LLM({
        model: openRouter.model,
        apiKey: openRouter.apiKey,
        baseURL: openRouter.baseUrl
      }),
      tts: new sarvam.TTS({
        model: ttsModel,
        speaker: ttsSpeaker,
        targetLanguageCode: normalizeSarvamTtsLanguageCode(language, logger),
        streaming: sarvamConfig.ttsStreaming
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
