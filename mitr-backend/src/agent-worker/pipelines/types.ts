import type { JobContext, voice } from '@livekit/agents';
import type { Env } from '../../config/env.js';

export type AgentVoicePipeline = Env['AGENT_VOICE_PIPELINE'];

export type PipelineLogger = {
  debug: (message: string, meta?: unknown) => void;
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
};

export type PipelineContext = {
  env: Env;
  logger: PipelineLogger;
  language: string;
  ctx: JobContext;
  isDeviceSession: boolean;
};

export type PipelinePrewarmContext = {
  env: Env;
  logger: PipelineLogger;
  proc: JobContext['proc'];
};

export interface VoicePipelineStrategy {
  readonly id: AgentVoicePipeline;
  prewarm?: (input: PipelinePrewarmContext) => Promise<void> | void;
  validate: (input: PipelineContext) => void;
  createSession: (input: PipelineContext) => voice.AgentSession;
}
