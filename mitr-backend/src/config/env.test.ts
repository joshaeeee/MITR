import { test } from 'node:test';
import assert from 'node:assert/strict';

const strongInternalToken = 'a'.repeat(64);
const productionGuardAcks: Record<string, string | undefined> = {
  REDIS_URL: 'redis://localhost:6379',
  QDRANT_API_KEY: 'qdrant-test-key',
  SHORT_CODE_PEPPER: 'b'.repeat(64),
  SECURITY_KEYS_ROTATED_ACK: 'true',
  PROD_SECRETS_OUT_OF_REPO_ACK: 'true',
  POSTGRES_STORAGE_ENCRYPTION_ACK: 'true',
  POSTGRES_BACKUPS_ENCRYPTION_ACK: 'true',
  CHECKOUT_DEV_PRICE_OVERRIDE_PAISE: undefined
};

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

test('importing env module does not throw when required vars are missing', async () => {
  // If the lazy Proxy regresses to eager parsing, this import would throw
  // because POSTGRES_URL is not set in a bare test environment.
  const mod = await import('./env.js');
  assert.ok(mod.env, 'env export should exist');
  assert.equal(typeof mod.validateEnv, 'function', 'validateEnv should be a function');
});

test('production env rejects unsafe launch settings', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'http://localhost:6333',
      CORS_ORIGINS: '*',
      CORS_ALLOW_MISSING_ORIGIN: 'true',
      API_PUBLIC_BASE_URL: 'http://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'ws://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'http://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: '',
      AUTH_DEV_OTP_BYPASS: 'true',
      AUTH_OTP_DELIVERY_MODE: 'dev_log',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'false'
    },
    () => {
      assert.throws(() => validateEnv(), /AUTH_DEV_OTP_BYPASS|CORS_ORIGINS|CORS_ALLOW_MISSING_ORIGIN|VOICE_GATEWAY_PUBLIC_WS_URL|VOICE_GATEWAY_PUBLIC_HTTP_URL/);
    }
  );
});

test('production env rejects weak internal service token', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'http://localhost:6333',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: 'internal-test-token',
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64')
    },
    () => {
      assert.throws(() => validateEnv(), /INTERNAL_SERVICE_TOKEN/);
    }
  );
});

test('production env rejects weak short-code pepper', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      SHORT_CODE_PEPPER: 'test-token',
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'http://localhost:6333',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64')
    },
    () => {
      assert.throws(() => validateEnv(), /SHORT_CODE_PEPPER/);
    }
  );
});

test('production env rejects placeholder public URLs', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'http://localhost:6333',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.example.com',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.example.com/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.example.com',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64')
    },
    () => {
      assert.throws(() => validateEnv(), /API_PUBLIC_BASE_URL|VOICE_GATEWAY_PUBLIC_WS_URL|VOICE_GATEWAY_PUBLIC_HTTP_URL/);
    }
  );
});

test('production env requires launch security acknowledgements', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      SECURITY_KEYS_ROTATED_ACK: 'false',
      PROD_SECRETS_OUT_OF_REPO_ACK: 'false',
      POSTGRES_STORAGE_ENCRYPTION_ACK: 'false',
      POSTGRES_BACKUPS_ENCRYPTION_ACK: 'false',
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'http://localhost:6333',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64')
    },
    () => {
      assert.throws(() => validateEnv(), /SECURITY_KEYS_ROTATED_ACK|PROD_SECRETS_OUT_OF_REPO_ACK|POSTGRES_STORAGE_ENCRYPTION_ACK|POSTGRES_BACKUPS_ENCRYPTION_ACK/);
    }
  );
});

test('production env requires Redis and Qdrant API key for hosted Qdrant', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      REDIS_URL: '',
      QDRANT_API_KEY: '',
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'https://qdrant.mitr.app',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64')
    },
    () => {
      assert.throws(() => validateEnv(), /REDIS_URL|QDRANT_API_KEY/);
    }
  );
});

test('production worker env accepts scoped worker configuration', async () => {
  const { validateWorkerEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      REDIS_URL: 'redis://redis:6379',
      MEM0_API_KEY: undefined,
      QDRANT_URL: undefined,
      QDRANT_API_KEY: undefined,
      INTERNAL_SERVICE_TOKEN: undefined,
      SHORT_CODE_PEPPER: undefined,
      API_PUBLIC_BASE_URL: undefined,
      VOICE_GATEWAY_PUBLIC_WS_URL: undefined,
      VOICE_GATEWAY_PUBLIC_HTTP_URL: undefined,
      VOICE_NOTES_ENCRYPTION_KEY_B64: undefined
    },
    () => {
      assert.doesNotThrow(() => validateWorkerEnv());
    }
  );
});

test('production env requires Twilio settings when phone OTP delivery is enabled', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'http://localhost:6333',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64'),
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'twilio',
      TWILIO_ACCOUNT_SID: '',
      TWILIO_AUTH_TOKEN: '',
      TWILIO_FROM_PHONE: ''
    },
    () => {
      assert.throws(() => validateEnv(), /TWILIO_ACCOUNT_SID|TWILIO_AUTH_TOKEN|TWILIO_FROM_PHONE/);
    }
  );
});

test('production env rejects non-HTTPS CORS origins', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'http://localhost:6333',
      CORS_ORIGINS: 'https://app.mitr.app,http://localhost:8787',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64')
    },
    () => {
      assert.throws(() => validateEnv(), /CORS_ORIGINS/);
    }
  );
});

test('production env requires explicit voice note local storage risk acknowledgment', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'http://localhost:6333',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64'),
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'false'
    },
    () => {
      assert.throws(() => validateEnv(), /VOICE_NOTES_LOCAL_STORAGE_ACK_RISK/);
    }
  );
});

test('production env requires voice note encryption key', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      POSTGRES_URL: 'postgresql://postgres:postgres@localhost:5432/mitr',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'http://localhost:6333',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: ''
    },
    () => {
      assert.throws(() => validateEnv(), /VOICE_NOTES_ENCRYPTION_KEY_B64/);
    }
  );
});

test('production env requires remote Postgres verify-full SSL mode', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      POSTGRES_URL: 'postgresql://mitr:secret@db.example.com:5432/mitr?sslmode=require',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'https://qdrant.mitr.app',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64')
    },
    () => {
      assert.throws(() => validateEnv(), /POSTGRES_URL/);
    }
  );
});

test('production env accepts remote Postgres verify-full SSL mode', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      POSTGRES_URL: 'postgresql://mitr:secret@db.example.com:5432/mitr?sslmode=verify-full',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'https://qdrant.mitr.app',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64')
    },
    () => {
      assert.doesNotThrow(() => validateEnv());
    }
  );
});

test('production env rejects checkout dev price override', async () => {
  const { validateEnv } = await import('./env.js');
  await withEnv(
    {
      NODE_ENV: 'production',
      ...productionGuardAcks,
      POSTGRES_URL: 'postgresql://mitr:secret@db.example.com:5432/mitr?sslmode=verify-full',
      MEM0_API_KEY: 'mem0-test',
      QDRANT_URL: 'https://qdrant.mitr.app',
      CORS_ORIGINS: 'https://app.mitr.app',
      API_PUBLIC_BASE_URL: 'https://api.mitr.app',
      VOICE_GATEWAY_PUBLIC_WS_URL: 'wss://api.mitr.app/ws',
      VOICE_GATEWAY_PUBLIC_HTTP_URL: 'https://api.mitr.app',
      INTERNAL_SERVICE_TOKEN: strongInternalToken,
      AUTH_DEV_OTP_BYPASS: 'false',
      AUTH_OTP_DELIVERY_MODE: 'disabled',
      VOICE_NOTES_LOCAL_STORAGE_ACK_RISK: 'true',
      VOICE_NOTES_ENCRYPTION_KEY_B64: Buffer.alloc(32, 1).toString('base64'),
      CHECKOUT_ENABLED: 'true',
      CHECKOUT_DEV_PRICE_OVERRIDE_PAISE: '100',
      RAZORPAY_KEY_ID: 'rzp_test_key',
      RAZORPAY_KEY_SECRET: 'razorpay-secret',
      RAZORPAY_WEBHOOK_SECRET: 'razorpay-webhook-secret'
    },
    () => {
      assert.throws(() => validateEnv(), /CHECKOUT_DEV_PRICE_OVERRIDE_PAISE/);
    }
  );
});

test('env proxy returns correct defaults for optional fields', async () => {
  const { env } = await import('./env.js');
  // PORT has a .default(8080) — accessing it should trigger parse and return the default.
  // This only needs the base required fields. API-only production checks run
  // through validateEnv(), not through the lazy proxy.
  const hasRequiredVars = Boolean(process.env.POSTGRES_URL);

  if (hasRequiredVars) {
    assert.equal(typeof env.PORT, 'number');
  } else {
    assert.throws(() => env.PORT, /invalid/i);
  }
});

test('validateEnv throws when required env vars are missing', async () => {
  const { validateEnv } = await import('./env.js');
  const hasRequiredVars = Boolean(process.env.POSTGRES_URL);

  if (hasRequiredVars) {
    // In a fully provisioned environment, validateEnv should succeed.
    assert.doesNotThrow(() => validateEnv());
  } else {
    // In a bare test environment, it should throw a Zod validation error.
    assert.throws(() => validateEnv(), /invalid/i);
  }
});
