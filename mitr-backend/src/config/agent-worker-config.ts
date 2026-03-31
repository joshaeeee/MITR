import type { Env } from './env.js';

export const isAsyncToolRuntimeV2Enabled = (env: Env): boolean => env.ASYNC_TOOL_RUNTIME_V2;

export const shouldIgnoreLegacyAsyncAlias = (
  env: Env,
  payloadType: string,
  isLegacyAlias: boolean
): boolean => isAsyncToolRuntimeV2Enabled(env) && isLegacyAlias && !payloadType.startsWith('tool_async_');

export const isSatsangAmbienceEnabled = (env: Env): boolean => env.SATSANG_AMBIENCE_ENABLED;
