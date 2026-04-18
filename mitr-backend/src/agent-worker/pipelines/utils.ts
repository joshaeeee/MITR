import * as sarvam from '@livekit/agents-plugin-sarvam';
import type { PipelineLogger } from './types.js';
import { sessionConfig } from '../../config/session-config.js';
export const SILERO_VAD_USERDATA_KEY = 'silero_vad';

type VoiceOptionsShape = {
  maxToolSteps: number;
  preemptiveGeneration: boolean;
  minInterruptionDuration: number;
  minInterruptionWords: number;
  minEndpointingDelay?: number;
  userAwayTimeout?: number | null;
};

export const withDeviceVoiceOptions = (
  voiceOptions: VoiceOptionsShape,
  isDeviceSession: boolean
): VoiceOptionsShape =>
  isDeviceSession
    ? { ...voiceOptions, userAwayTimeout: sessionConfig.deviceConversationIdleTimeoutSec }
    : voiceOptions;

export const normalizeSarvamLanguageCode = (language: string): string => {
  const trimmed = language.trim();
  if (!trimmed) return 'hi-IN';
  const exact = /^[a-z]{2}-[A-Z]{2}$/.test(trimmed);
  if (exact) return trimmed;
  const normalized = trimmed.replace('_', '-');
  if (/^[a-z]{2}$/.test(normalized)) return `${normalized}-IN`;
  return 'hi-IN';
};

const TTS_LANGUAGE_CODES = new Set<string>([
  'bn-IN',
  'en-IN',
  'gu-IN',
  'hi-IN',
  'kn-IN',
  'ml-IN',
  'mr-IN',
  'od-IN',
  'pa-IN',
  'ta-IN',
  'te-IN'
]);

export const normalizeSarvamTtsLanguageCode = (
  language: string,
  logger: PipelineLogger
): string => {
  const normalized = normalizeSarvamLanguageCode(language);
  if (TTS_LANGUAGE_CODES.has(normalized)) return normalized;
  logger.warn('Unsupported TTS language for Sarvam; falling back to hi-IN', {
    providedLanguage: language,
    normalizedLanguage: normalized
  });
  return 'hi-IN';
};

export const normalizeSarvamTtsModel = (model: string, logger: PipelineLogger): sarvam.TTSModels => {
  const normalized = model.trim().toLowerCase();
  if (normalized === 'bulbul:v3' || normalized.startsWith('bulbul:v3')) return 'bulbul:v3';
  logger.warn('Unknown SARVAM_TTS_MODEL; falling back to bulbul:v3', {
    providedModel: model
  });
  return 'bulbul:v3';
};

const V3_SPEAKERS = new Set<string>([
  'shubh',
  'aditya',
  'ritu',
  'priya',
  'neha',
  'rahul',
  'pooja',
  'rohan',
  'simran',
  'kavya',
  'amit',
  'dev',
  'ishita',
  'shreya',
  'ratan',
  'varun',
  'manan',
  'sumit',
  'roopa',
  'kabir',
  'aayan',
  'ashutosh',
  'advait',
  'amelia',
  'sophia',
  'anand',
  'tanya',
  'tarun',
  'sunny',
  'mani',
  'gokul',
  'vijay',
  'shruti',
  'suhani',
  'mohit',
  'kavitha',
  'rehan',
  'soham',
  'rupali'
]);

export const normalizeSarvamTtsSpeaker = (
  model: sarvam.TTSModels,
  speaker: string,
  logger: PipelineLogger
): string => {
  const normalized = speaker.trim().toLowerCase();
  if (!normalized) {
    logger.warn('Empty SARVAM_TTS_SPEAKER; falling back to shubh for bulbul:v3');
    return 'shubh';
  }
  if (model === 'bulbul:v3') {
    if (V3_SPEAKERS.has(normalized)) return normalized;
    logger.warn('Unsupported SARVAM_TTS_SPEAKER for bulbul:v3; falling back to shubh', {
      providedSpeaker: speaker
    });
    return 'shubh';
  }
  return normalized;
};

export const normalizeGoogleRealtimeModel = (configuredModel: string): string =>
  configuredModel
    .trim()
    .replace(/^models\//i, '')
    .replace(/^google\//i, '');
