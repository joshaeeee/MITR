import assert from 'node:assert/strict';
import test from 'node:test';
import type { Env } from './env.js';
import {
  isAsyncToolRuntimeV2Enabled,
  isSatsangAmbienceEnabled,
  shouldIgnoreLegacyAsyncAlias
} from './agent-worker-config.js';

const buildEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    ASYNC_TOOL_RUNTIME_V2: true,
    SATSANG_AMBIENCE_ENABLED: false,
    ...overrides
  }) as Env;

test('agent worker config helpers expose feature flags and async alias behavior', () => {
  const env = buildEnv();

  assert.equal(isAsyncToolRuntimeV2Enabled(env), true);
  assert.equal(isSatsangAmbienceEnabled(env), false);
  assert.equal(shouldIgnoreLegacyAsyncAlias(env, 'news_retrieve_ready', true), true);
  assert.equal(shouldIgnoreLegacyAsyncAlias(env, 'tool_async_ready', true), false);
  assert.equal(shouldIgnoreLegacyAsyncAlias(buildEnv({ ASYNC_TOOL_RUNTIME_V2: false }), 'news_retrieve_ready', true), false);
  assert.equal(shouldIgnoreLegacyAsyncAlias(env, 'news_retrieve_ready', false), false);
});
