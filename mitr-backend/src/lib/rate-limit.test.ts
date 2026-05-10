import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyFieldsKey, rateLimitKeyDigest } from './rate-limit.js';
import type { FastifyRequest } from 'fastify';

test('rateLimitKeyDigest does not expose raw user-controlled values', () => {
  const raw = '192.0.2.10:Security.Smoke+User@example.com';
  const digest = rateLimitKeyDigest(raw);

  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.ok(!digest.includes('security'));
  assert.ok(!digest.includes('example'));
  assert.notEqual(digest, raw.toLowerCase());
  assert.equal(digest, rateLimitKeyDigest(`  ${raw.toUpperCase()}  `));
});

test('bodyFieldsKey binds rate limits to every selected body field', () => {
  const key = bodyFieldsKey(['deviceId', 'claimCode']);
  const request = {
    ip: '203.0.113.8',
    body: {
      deviceId: ' Device-A ',
      claimCode: ' 123456 '
    }
  } as FastifyRequest;
  const differentClaim = {
    ip: '203.0.113.8',
    body: {
      deviceId: ' Device-A ',
      claimCode: ' 654321 '
    }
  } as FastifyRequest;

  assert.equal(key(request), '203.0.113.8:deviceId=device-a:claimCode=123456');
  assert.notEqual(key(request), key(differentClaim));
});
