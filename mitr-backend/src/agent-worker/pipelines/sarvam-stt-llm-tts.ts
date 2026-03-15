import { voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as silero from '@livekit/agents-plugin-silero';
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
    if (env.AGENT_VOICE_PIPELINE !== 'sarvam_stt_llm_tts') return;
    if (proc.userData[SILERO_VAD_USERDATA_KEY]) return;
    // Reduce silence threshold from default 550ms → 400ms: fires END_OF_SPEECH sooner,
    // cutting ~150ms off every turn in vad turn-detection mode.
    proc.userData[SILERO_VAD_USERDATA_KEY] = await silero.VAD.load({ minSilenceDuration: 400 });
  },
  validate({ env, ctx }) {
    if (!env.OPENROUTER_API_KEY) {
      throw new Error('OPENROUTER_API_KEY is required when AGENT_VOICE_PIPELINE=sarvam_stt_llm_tts');
    }
    if (!env.SARVAM_API_KEY) {
      throw new Error('SARVAM_API_KEY is required when AGENT_VOICE_PIPELINE=sarvam_stt_llm_tts');
    }
    if (!ctx.proc.userData[SILERO_VAD_USERDATA_KEY]) {
      throw new Error(
        'AGENT_VOICE_PIPELINE=sarvam_stt_llm_tts requires a prewarmed Silero VAD model, but none was found.'
      );
    }
  },
  createSession({ env, logger, language, ctx }) {
    const ttsModel = normalizeSarvamTtsModel(env.SARVAM_TTS_MODEL, logger);
    const ttsSpeaker = normalizeSarvamTtsSpeaker(ttsModel, env.SARVAM_TTS_SPEAKER, logger);
    const sarvamNonStreamingStt = !env.SARVAM_STT_STREAMING;
    const prewarmedVad = ctx.proc.userData[SILERO_VAD_USERDATA_KEY] as silero.VAD | undefined;

    return new voice.AgentSession({
      turnDetection: sarvamNonStreamingStt ? 'vad' : 'stt',
      vad: prewarmedVad,
      stt: new sarvam.STT({
        model: env.SARVAM_STT_MODEL as sarvam.STTModels,
        languageCode: normalizeSarvamLanguageCode(language),
        mode: env.SARVAM_STT_MODE as sarvam.STTModes,
        streaming: env.SARVAM_STT_STREAMING
      }),
      llm: new openai.LLM({
        model: env.OPENROUTER_MODEL,
        apiKey: env.OPENROUTER_API_KEY,
        baseURL: env.OPENROUTER_BASE_URL
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
        minInterruptionDuration: 600,
        minInterruptionWords: 2,
        // Reduce silence wait before LLM fires: default 500ms → 350ms saves ~150ms per turn.
        minEndpointingDelay: 350
      }
    });
  }
};
