import 'dotenv/config';
import { z } from 'zod';

const envBoolean = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    }
    return value;
  }, z.boolean().default(defaultValue));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOCAL_LATENCY_TRACKING_FILE: z.string().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:8787'),
  API_PUBLIC_BASE_URL: z.string().url().optional(),
  INTERNAL_API_BASE_URL: z.string().url().optional(),
  VOICE_NOTES_STORAGE_DIR: z.string().default('var/voice-notes'),

  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().min(1).optional(),
  LIVEKIT_API_SECRET: z.string().min(1).optional(),
  LIVEKIT_AGENT_NAME: z.string().default('mitr-agent'),
  LIVEKIT_TOKEN_TTL_SEC: z.coerce.number().default(3600),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_CHAT_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime'),
  OPENAI_REALTIME_VOICE: z.string().default('alloy'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('openai/gpt-4o-mini'),
  AGENT_VOICE_PIPELINE: z
    .enum([
      'openai_realtime',
      'sarvam_stt_llm_tts',
      'sarvam_stt_llm_cartesia_tts',
      'gemini_realtime_text_sarvam_tts',
      'gemini_realtime_text_cartesia_tts',
      'gemini_realtime',
      'livekit_inference'
    ])
    .default('sarvam_stt_llm_tts'),
  INFERENCE_LLM_MODEL: z.string().default('openai/gpt-4o-mini'),
  INFERENCE_STT_MODEL: z.string().default('deepgram/nova-3-general'),
  INFERENCE_TTS_MODEL: z.string().default('cartesia/sonic-3'),
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_REALTIME_MODEL: z.string().default('gemini-3.1-pro-preview'),
  CARTESIA_API_KEY: z.string().optional(),
  CARTESIA_MODEL: z.string().default('sonic-3'),
  CARTESIA_VOICE_ID: z.string().default('794f9389-aac1-45b6-b726-9d9369183238'),
  CARTESIA_LANGUAGE: z.string().default('hi'),
  CARTESIA_BASE_URL: z.string().url().default('https://api.cartesia.ai'),
  CARTESIA_CHUNK_TIMEOUT_MS: z.coerce.number().default(500),

  SARVAM_API_KEY: z.string().optional(),
  SARVAM_STT_MODEL: z.string().default('saaras:v3'),
  SARVAM_STT_MODE: z.string().default('transcribe'),
  SARVAM_STT_STREAMING: envBoolean(true),
  SARVAM_TTS_MODEL: z.string().default('bulbul:v3'),
  SARVAM_TTS_SPEAKER: z.string().default('shubh'),
  SARVAM_TTS_STREAMING: envBoolean(true),
  SATSANG_AMBIENCE_ENABLED: envBoolean(false),
  ASYNC_TOOL_RUNTIME_V2: envBoolean(true),

  AUTH_SESSION_TTL_SEC: z.coerce.number().default(3600),
  AUTH_REFRESH_TTL_SEC: z.coerce.number().default(60 * 60 * 24 * 30),
  AUTH_OTP_TTL_SEC: z.coerce.number().default(300),
  AUTH_REVOKED_SESSION_RETENTION_SEC: z.coerce.number().default(60 * 60 * 24 * 7),
  AUTH_OTP_CONSUMED_RETENTION_SEC: z.coerce.number().default(60 * 60 * 24),
  AUTH_DEV_OTP_BYPASS: envBoolean(true),
  AUTH_DEV_OTP_CODE: z.string().default('123456'),

  DEVICE_TOKEN_TTL_SEC: z.coerce.number().default(86_400),
  SESSION_IDLE_TIMEOUT_SEC: z.coerce.number().default(1_800),
  DEVICE_CONVERSATION_IDLE_TIMEOUT_MS: z.coerce.number().default(20_000),
  DEVICE_PERSISTENT_AGENT_SESSION: envBoolean(true),
  DEVICE_AGENT_READY_TIMEOUT_MS: z.coerce.number().default(30_000),
  DEVICE_AGENT_STALE_MS: z.coerce.number().default(60_000),
  DEVICE_AGENT_HEARTBEAT_MS: z.coerce.number().default(15_000),
  DEVICE_SESSION_STALE_SEC: z.coerce.number().default(60 * 60 * 24),
  INTERNAL_SERVICE_TOKEN: z.string().min(1).optional(),
  REDIS_URL: z.string().url().optional(),
  POSTGRES_URL: z.string().url(),

  MEM0_API_KEY: z.string().min(1),
  MEM0_BASE_URL: z.string().url().default('https://api.mem0.ai'),
  MEM0_ORG_ID: z.string().optional(),
  MEM0_PROJECT_ID: z.string().optional(),
  MEM0_ADD_TIMEOUT_MS: z.coerce.number().default(5000),
  MEM0_SEARCH_TIMEOUT_MS: z.coerce.number().default(3500),

  QDRANT_URL: z.string().url(),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_CHECK_COMPATIBILITY: envBoolean(false),
  QDRANT_COLLECTION: z.string().default('religious_texts'),

  EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-large'),
  EMBEDDING_PROVIDER_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MAX_BATCH_SIZE: z.coerce.number().default(64),
  EMBEDDING_AUTH_TYPE: z.enum(['bearer', 'api-key', 'none']).default('bearer'),
  STORY_RETRIEVE_TIMEOUT_MS: z.coerce.number().default(7000),

  EXA_API_KEY: z.string().optional(),
  EXA_BASE_URL: z.string().url().default('https://api.exa.ai'),
  EXA_DEFAULT_REGION: z.string().default('IN'),
  EXA_DEFAULT_NUM_RESULTS: z.coerce.number().default(6),
  EXA_DEFAULT_RECENCY_DAYS: z.coerce.number().default(3),
  EXA_INCLUDE_DOMAINS: z.string().optional(),
  EXA_NEWS_SEARCH_TYPE: z.enum(['auto', 'fast', 'instant', 'neural', 'deep']).default('auto'),
  EXA_NEWS_TEXT_MAX_CHARS: z.coerce.number().default(2600),
  EXA_NEWS_HIGHLIGHT_SENTENCES: z.coerce.number().default(3),
  EXA_NEWS_HIGHLIGHTS_PER_URL: z.coerce.number().default(3),
  EXA_NEWS_SUMMARY_STYLE: z.enum(['brief', 'detailed']).default('detailed'),

  GEOCODING_BASE_URL: z.string().url().default('https://geocoding-api.open-meteo.com/v1'),
  GEOCODING_TIMEOUT_MS: z.coerce.number().default(3000),
  GEOCODING_DEFAULT_COUNTRY: z.string().default('IN'),

  PROKERALA_CLIENT_ID: z.string().optional(),
  PROKERALA_CLIENT_SECRET: z.string().optional(),
  PROKERALA_BASE_URL: z.string().url().default('https://api.prokerala.com/v2'),
  PROKERALA_TOKEN_URL: z.string().url().default('https://api.prokerala.com/token'),
  PROKERALA_TIMEOUT_MS: z.coerce.number().default(7000),

  BHAGAVAD_GITA_PROVIDER: z.enum(['vedicscriptures', 'bhagavadgita_io']).default('vedicscriptures'),
  BHAGAVAD_GITA_API_BASE_URL: z.string().url().default('https://vedicscriptures.github.io'),
  BHAGAVAD_GITA_API_KEY: z.string().optional(),
  BHAGAVAD_GITA_TIMEOUT_MS: z.coerce.number().default(3500),

  YTDLP_PATH: z.string().default('yt-dlp'),
  YTDLP_TIMEOUT_MS: z.coerce.number().default(20_000),
  YTDLP_SEARCH_TIMEOUT_MS: z.coerce.number().default(7_000),
  YTDLP_STREAM_TIMEOUT_MS: z.coerce.number().default(8_000),
  YOUTUBE_MEDIA_TIMEOUT_MS: z.coerce.number().default(12_000),
  LONG_SESSION_STALE_MS: z.coerce.number().default(45_000),
  INSIGHTS_REALTIME_POLL_SEC: z.coerce.number().default(60),
  DIGEST_JOB_CRON_UTC: z.string().default('* * * * *'),
  DIGEST_DEFAULT_HOUR: z.coerce.number().min(0).max(23).default(20),
  DIGEST_DEFAULT_MINUTE: z.coerce.number().min(0).max(59).default(30),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  MAINTENANCE_CLEANUP_INTERVAL_SEC: z.coerce.number().default(900),
  USER_EVENT_STREAM_RETENTION_SEC: z.coerce.number().default(60 * 60 * 24 * 14)
});

export type Env = z.infer<typeof envSchema>;

/** Validate all env vars eagerly. Call at startup entry points. */
export const validateEnv = (): Env => envSchema.parse(process.env);

let _cached: Env | undefined;
const _parse = (): Env => {
  _cached ??= envSchema.parse(process.env);
  return _cached;
};

/**
 * Lazy env proxy — schema is NOT parsed at import time.
 * First property access triggers full validation and caches the result.
 * Call validateEnv() at startup for fast-fail behavior.
 */
export const env: Env = new Proxy({} as Env, {
  get(_, prop: string) {
    return _parse()[prop as keyof Env];
  }
});
