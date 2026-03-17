import { test } from 'node:test';
import assert from 'node:assert/strict';

test('importing env module does not throw when required vars are missing', async () => {
  // If the lazy Proxy regresses to eager parsing, this import would throw
  // because POSTGRES_URL / MEM0_API_KEY / QDRANT_URL are not set in the
  // test environment.
  const mod = await import('./env.js');
  assert.ok(mod.env, 'env export should exist');
  assert.equal(typeof mod.validateEnv, 'function', 'validateEnv should be a function');
});

test('env proxy returns correct defaults for optional fields', async () => {
  const { env } = await import('./env.js');
  // PORT has a .default(8080) — accessing it should trigger parse and return the default.
  // This will only work if the 3 required fields (POSTGRES_URL, MEM0_API_KEY, QDRANT_URL)
  // are present in the environment. If they are not, this test verifies that accessing
  // a property correctly propagates the Zod validation error.
  const hasRequiredVars =
    Boolean(process.env.POSTGRES_URL) &&
    Boolean(process.env.MEM0_API_KEY) &&
    Boolean(process.env.QDRANT_URL);

  if (hasRequiredVars) {
    assert.equal(typeof env.PORT, 'number');
  } else {
    assert.throws(() => env.PORT, /invalid/i);
  }
});

test('validateEnv throws when required env vars are missing', async () => {
  const { validateEnv } = await import('./env.js');
  const hasRequiredVars =
    Boolean(process.env.POSTGRES_URL) &&
    Boolean(process.env.MEM0_API_KEY) &&
    Boolean(process.env.QDRANT_URL);

  if (hasRequiredVars) {
    // In a fully provisioned environment, validateEnv should succeed.
    assert.doesNotThrow(() => validateEnv());
  } else {
    // In a bare test environment, it should throw a Zod validation error.
    assert.throws(() => validateEnv(), /invalid/i);
  }
});
