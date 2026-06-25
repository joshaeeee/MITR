import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  CHECKOUT_ADMIN_SESSION_TTL_SEC,
  checkoutAdminCredentialVersion,
  createCheckoutAdminSessionToken,
  verifyCheckoutAdminSessionToken
} from './checkout-admin-auth.js';

const secret = 's'.repeat(64);
const nowMs = Date.UTC(2026, 5, 25, 12, 0, 0);

test('checkout admin session tokens are signed and expire after eight hours', () => {
  const adminId = randomUUID();
  const credentialVersion = checkoutAdminCredentialVersion('password-hash-one', secret);
  const token = createCheckoutAdminSessionToken(adminId, secret, credentialVersion, nowMs, 'fixed-session-nonce-12345');
  const payload = verifyCheckoutAdminSessionToken(token, secret, nowMs);

  assert.equal(payload?.sub, adminId);
  assert.equal(payload?.exp - (payload?.iat ?? 0), CHECKOUT_ADMIN_SESSION_TTL_SEC);
  assert.equal(verifyCheckoutAdminSessionToken(token, secret, nowMs + CHECKOUT_ADMIN_SESSION_TTL_SEC * 1000), null);
});

test('checkout admin session tokens reject tampering and the wrong signing secret', () => {
  const credentialVersion = checkoutAdminCredentialVersion('password-hash-one', secret);
  const token = createCheckoutAdminSessionToken(randomUUID(), secret, credentialVersion, nowMs, 'fixed-session-nonce-12345');
  const [payload, signature] = token.split('.');

  assert.equal(verifyCheckoutAdminSessionToken(`${payload}x.${signature}`, secret, nowMs), null);
  assert.equal(verifyCheckoutAdminSessionToken(token, 'x'.repeat(64), nowMs), null);
});

test('checkout admin credential versions change when the password hash changes', () => {
  assert.notEqual(
    checkoutAdminCredentialVersion('password-hash-one', secret),
    checkoutAdminCredentialVersion('password-hash-two', secret)
  );
});
