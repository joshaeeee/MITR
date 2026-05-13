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

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const isWeakProductionSecret = (value: string | undefined, minLength = 32): boolean => {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized.length < minLength) return true;
  return [
    'changeme',
    'change_me',
    'placeholder',
    'internal-test-token',
    'internal-token-test',
    'test-token'
  ].includes(normalized);
};

const isProductionPlaceholder = (value: string | undefined): boolean => {
  const normalized = (value ?? '').trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.includes('example.com') ||
    normalized.includes('.example') ||
    normalized.includes('localhost') ||
    normalized.includes('127.0.0.1') ||
    normalized.includes('placeholder') ||
    ['changeme', 'change_me'].includes(normalized)
  );
};

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8080),
  TRUST_PROXY: envBoolean(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOCAL_LATENCY_TRACKING_FILE: z.string().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:8787'),
  CORS_ALLOW_MISSING_ORIGIN: envBoolean(false),
  API_PUBLIC_BASE_URL: z.string().url().optional(),
  INTERNAL_API_BASE_URL: z.string().url().optional(),
  VOICE_NOTES_STORAGE_DIR: z.string().default('var/voice-notes'),
  VOICE_NOTES_ENCRYPTION_KEY_B64: z.string().optional(),
  VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: envBoolean(false),
  SECURITY_KEYS_ROTATED_ACK: envBoolean(false),
  PROD_SECRETS_OUT_OF_REPO_ACK: envBoolean(false),
  POSTGRES_STORAGE_ENCRYPTION_ACK: envBoolean(false),
  POSTGRES_BACKUPS_ENCRYPTION_ACK: envBoolean(false),
  PIPECAT_GATEWAY_PUBLIC_WS_URL: z.string().url().default('ws://localhost:7860/ws'),
  PIPECAT_GATEWAY_PUBLIC_HTTP_URL: z.string().url().default('http://localhost:7860'),

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
      'gemini_realtime'
    ])
    .default('openai_realtime'),
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
  AUTH_OTP_DELIVERY_MODE: z.enum(['disabled', 'dev_log', 'twilio']).default('disabled'),
  AUTH_DEV_OTP_BYPASS: envBoolean(false),
  AUTH_DEV_OTP_CODE: z.string().default('123456'),
  AUTH_LOCKOUT_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
  AUTH_LOCKOUT_WINDOW_SEC: z.coerce.number().int().min(30).default(15 * 60),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_PHONE: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_IDS: z.string().optional(),
  APPLE_OAUTH_CLIENT_IDS: z.string().optional(),

  DEVICE_TOKEN_TTL_SEC: z.coerce.number().default(86_400),
  SESSION_IDLE_TIMEOUT_SEC: z.coerce.number().default(1_800),
  DEVICE_CONVERSATION_IDLE_TIMEOUT_MS: z.coerce.number().default(20_000),
  DEVICE_PERSISTENT_AGENT_SESSION: envBoolean(true),
  DEVICE_AGENT_READY_TIMEOUT_MS: z.coerce.number().default(30_000),
  DEVICE_AGENT_STALE_MS: z.coerce.number().default(60_000),
  DEVICE_AGENT_HEARTBEAT_MS: z.coerce.number().default(15_000),
  DEVICE_SESSION_STALE_SEC: z.coerce.number().default(60 * 60 * 24),
  INTERNAL_SERVICE_TOKEN: z.string().min(1).optional(),
  SHORT_CODE_PEPPER: z.string().optional(),
  REDIS_URL: z.string().url().optional(),
  POSTGRES_URL: z.string().url(),

  MEM0_API_KEY: z.string().min(1).optional(),
  MEM0_BASE_URL: z.string().url().default('https://api.mem0.ai'),
  MEM0_ORG_ID: z.string().optional(),
  MEM0_PROJECT_ID: z.string().optional(),
  MEM0_ADD_TIMEOUT_MS: z.coerce.number().default(5000),
  MEM0_SEARCH_TIMEOUT_MS: z.coerce.number().default(3500),

  QDRANT_URL: z.string().url().optional(),
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

const requireProductionPostgresTls = (
  env: z.infer<typeof baseEnvSchema>,
  ctx: z.RefinementCtx
): void => {
  const postgresUrl = new URL(env.POSTGRES_URL);
  const sslMode = postgresUrl.searchParams.get('sslmode')?.toLowerCase();
  const localPostgresHosts = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);
  if (!localPostgresHosts.has(postgresUrl.hostname) && sslMode !== 'verify-full') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['POSTGRES_URL'],
      message: 'POSTGRES_URL must include sslmode=verify-full in production'
    });
  }
};

const apiEnvSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;

  if (env.AUTH_DEV_OTP_BYPASS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_DEV_OTP_BYPASS'],
      message: 'AUTH_DEV_OTP_BYPASS must be false in production'
    });
  }

  if (env.AUTH_OTP_DELIVERY_MODE === 'dev_log') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_OTP_DELIVERY_MODE'],
      message: 'AUTH_OTP_DELIVERY_MODE=dev_log is not allowed in production'
    });
  }

  if (env.AUTH_OTP_DELIVERY_MODE === 'twilio') {
    for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_PHONE'] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when AUTH_OTP_DELIVERY_MODE=twilio`
        });
      }
    }
  }

  for (const key of [
    'SECURITY_KEYS_ROTATED_ACK',
    'PROD_SECRETS_OUT_OF_REPO_ACK',
    'POSTGRES_STORAGE_ENCRYPTION_ACK',
    'POSTGRES_BACKUPS_ENCRYPTION_ACK'
  ] as const) {
    if (!env[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must be true in production`
      });
    }
  }

  if (!env.INTERNAL_SERVICE_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['INTERNAL_SERVICE_TOKEN'],
      message: 'INTERNAL_SERVICE_TOKEN is required in production'
    });
  } else if (isWeakProductionSecret(env.INTERNAL_SERVICE_TOKEN, 32)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['INTERNAL_SERVICE_TOKEN'],
      message: 'INTERNAL_SERVICE_TOKEN must be a high-entropy secret in production'
    });
  }

  if (!env.SHORT_CODE_PEPPER) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SHORT_CODE_PEPPER'],
      message: 'SHORT_CODE_PEPPER is required in production'
    });
  } else if (isWeakProductionSecret(env.SHORT_CODE_PEPPER, 32)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SHORT_CODE_PEPPER'],
      message: 'SHORT_CODE_PEPPER must be a high-entropy secret in production'
    });
  }

  if (!env.REDIS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'REDIS_URL is required in production'
    });
  }

  const corsOrigins = csv(env.CORS_ORIGINS);
  if (corsOrigins.length === 0 || corsOrigins.includes('*')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CORS_ORIGINS'],
      message: 'CORS_ORIGINS must be explicit in production'
    });
  }
  const insecureCorsOrigin = corsOrigins.find((origin) => {
    const normalized = origin.toLowerCase();
    return !normalized.startsWith('https://') || isProductionPlaceholder(origin);
  });
  if (insecureCorsOrigin) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CORS_ORIGINS'],
      message: 'CORS_ORIGINS must contain only HTTPS production origins'
    });
  }
  if (env.CORS_ALLOW_MISSING_ORIGIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CORS_ALLOW_MISSING_ORIGIN'],
      message: 'CORS_ALLOW_MISSING_ORIGIN must be false in production'
    });
  }

  if (!env.PIPECAT_GATEWAY_PUBLIC_WS_URL.startsWith('wss://') || isProductionPlaceholder(env.PIPECAT_GATEWAY_PUBLIC_WS_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PIPECAT_GATEWAY_PUBLIC_WS_URL'],
      message: 'Pipecat gateway WebSocket URL must be a real wss:// URL in production'
    });
  }

  if (!env.PIPECAT_GATEWAY_PUBLIC_HTTP_URL.startsWith('https://') || isProductionPlaceholder(env.PIPECAT_GATEWAY_PUBLIC_HTTP_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PIPECAT_GATEWAY_PUBLIC_HTTP_URL'],
      message: 'Pipecat gateway HTTP URL must be a real https:// URL in production'
    });
  }

  if (!env.API_PUBLIC_BASE_URL?.startsWith('https://') || isProductionPlaceholder(env.API_PUBLIC_BASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['API_PUBLIC_BASE_URL'],
      message: 'API_PUBLIC_BASE_URL must be a real https:// URL in production'
    });
  }

  requireProductionPostgresTls(env, ctx);

  if (!env.MEM0_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['MEM0_API_KEY'],
      message: 'MEM0_API_KEY is required in production'
    });
  }

  if (!env.QDRANT_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['QDRANT_URL'],
      message: 'QDRANT_URL is required in production'
    });
  }

  if (!env.VOICE_NOTES_LOCAL_STORAGE_ACK_RISK) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['VOICE_NOTES_LOCAL_STORAGE_ACK_RISK'],
      message: 'Production voice note storage is local disk; set VOICE_NOTES_LOCAL_STORAGE_ACK_RISK=true only after provisioning encrypted storage/backups'
    });
  }

  if (!env.VOICE_NOTES_ENCRYPTION_KEY_B64) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['VOICE_NOTES_ENCRYPTION_KEY_B64'],
      message: 'VOICE_NOTES_ENCRYPTION_KEY_B64 is required in production'
    });
  } else if (Buffer.from(env.VOICE_NOTES_ENCRYPTION_KEY_B64, 'base64').length !== 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['VOICE_NOTES_ENCRYPTION_KEY_B64'],
      message: 'VOICE_NOTES_ENCRYPTION_KEY_B64 must decode to 32 bytes'
    });
  }

  if (env.QDRANT_URL?.startsWith('https://') && !env.QDRANT_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['QDRANT_API_KEY'],
      message: 'QDRANT_API_KEY is required in production when QDRANT_URL uses https'
    });
  }
});

const workerEnvSchema = baseEnvSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return;

  if (!env.REDIS_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'REDIS_URL is required in production'
    });
  }

  requireProductionPostgresTls(env, ctx);
});

export type Env = z.infer<typeof baseEnvSchema>;

/** Validate all env vars eagerly. Call at startup entry points. */
export const validateEnv = (): Env => apiEnvSchema.parse(process.env);

/** Validate the narrower env surface used by production background workers. */
export const validateWorkerEnv = (): Env => workerEnvSchema.parse(process.env);

let _cached: Env | undefined;
const _parse = (): Env => {
  _cached ??= baseEnvSchema.parse(process.env);
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
