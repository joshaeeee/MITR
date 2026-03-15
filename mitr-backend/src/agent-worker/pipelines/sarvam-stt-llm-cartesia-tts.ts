import { voice } from '@livekit/agents';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as openai from '@livekit/agents-plugin-openai';
import * as sarvam from '@livekit/agents-plugin-sarvam';
import * as silero from '@livekit/agents-plugin-silero';
import type { VoicePipelineStrategy } from './types.js';
import { normalizeSarvamLanguageCode, SILERO_VAD_USERDATA_KEY } from './utils.js';

export const sarvamSttLlmCartesiaTtsPipeline: VoicePipelineStrategy = {
  id: 'sarvam_stt_llm_cartesia_tts',
  async prewarm({ env, proc }) {
    if (env.AGENT_VOICE_PIPELINE !== 'sarvam_stt_llm_cartesia_tts') return;
    if (proc.userData[SILERO_VAD_USERDATA_KEY]) return;
    proc.userData[SILERO_VAD_USERDATA_KEY] = await silero.VAD.load({ minSilenceDuration: 400 });
  },
  validate({ env, ctx }) {
    if (!env.OPENROUTER_API_KEY) {
      throw new Error(
        'OPENROUTER_API_KEY is required when AGENT_VOICE_PIPELINE=sarvam_stt_llm_cartesia_tts'
      );
    }
    if (!env.SARVAM_API_KEY) {
      throw new Error(
        'SARVAM_API_KEY is required when AGENT_VOICE_PIPELINE=sarvam_stt_llm_cartesia_tts'
      );
    }
    if (!env.CARTESIA_API_KEY) {
      throw new Error(
        'CARTESIA_API_KEY is required when AGENT_VOICE_PIPELINE=sarvam_stt_llm_cartesia_tts'
      );
    }
    if (!ctx.proc.userData[SILERO_VAD_USERDATA_KEY]) {
      throw new Error(
        'AGENT_VOICE_PIPELINE=sarvam_stt_llm_cartesia_tts requires a prewarmed Silero VAD model, but none was found.'
      );
    }
  },
  createSession({ env, ctx, language }) {
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
        minInterruptionDuration: 600,
        minInterruptionWords: 2,
        minEndpointingDelay: 350
      }
    });
  }
};
