import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertAuthNotLocked, recordAuthFailure, recordAuthSuccess } from './auth-attempts.js';

test('auth attempts lock after configured failure threshold and clear on success', () => {
  const key = `test:${randomUUID()}`;
  const options = { maxFailures: 2, windowSec: 60 };

  assert.doesNotThrow(() => assertAuthNotLocked(key, options));
  recordAuthFailure(key, options);
  assert.doesNotThrow(() => assertAuthNotLocked(key, options));
  recordAuthFailure(key, options);
  assert.throws(() => assertAuthNotLocked(key, options), /Too many failed attempts/);

  recordAuthSuccess(key);
  assert.doesNotThrow(() => assertAuthNotLocked(key, options));
});
