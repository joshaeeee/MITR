import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashShortCode } from './short-code-hash.js';

const withEnv = async (patch: Record<string, string | undefined>, fn: () => void | Promise<void>) => {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test('hashShortCode uses a keyed digest and purpose separation', async () => {
  await withEnv({ SHORT_CODE_PEPPER: 'pepper-a', NODE_ENV: 'test' }, () => {
    const otpHash = hashShortCode('otp', '123456');
    const claimHash = hashShortCode('device-claim', '123456');

    assert.match(otpHash, /^[a-f0-9]{64}$/);
    assert.notEqual(otpHash, claimHash);
    assert.notEqual(otpHash, '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92');
  });
});

test('hashShortCode changes when the pepper changes', async () => {
  await withEnv({ SHORT_CODE_PEPPER: 'pepper-a', NODE_ENV: 'test' }, () => {
    const first = hashShortCode('otp', '123456');
    process.env.SHORT_CODE_PEPPER = 'pepper-b';
    assert.notEqual(first, hashShortCode('otp', '123456'));
  });
});

test('hashShortCode fails closed in production without a pepper', async () => {
  await withEnv({ SHORT_CODE_PEPPER: undefined, NODE_ENV: 'production' }, () => {
    assert.throws(() => hashShortCode('otp', '123456'), /SHORT_CODE_PEPPER/);
  });
});
