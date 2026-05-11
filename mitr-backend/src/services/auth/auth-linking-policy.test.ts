import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canUseEmailIdentityForPrimaryLogin,
  shouldCreateEmailIdentity,
  toTrustedEmailKey
} from './auth-linking-policy.js';

test('OAuth providers do not use email identities as primary login keys', () => {
  assert.equal(canUseEmailIdentityForPrimaryLogin('google'), false);
  assert.equal(canUseEmailIdentityForPrimaryLogin('apple'), false);
  assert.equal(canUseEmailIdentityForPrimaryLogin('email'), true);
});

test('OAuth providers do not create email-provider identities', () => {
  assert.equal(shouldCreateEmailIdentity('google'), false);
  assert.equal(shouldCreateEmailIdentity('apple'), false);
  assert.equal(shouldCreateEmailIdentity('email'), true);
});

test('trusted email keys require email auth or verified OAuth email', () => {
  assert.equal(toTrustedEmailKey({ provider: 'email', email: ' User@Example.COM ' }), 'user@example.com');
  assert.equal(toTrustedEmailKey({ provider: 'google', email: 'User@Example.COM', emailVerified: true }), 'user@example.com');
  assert.equal(toTrustedEmailKey({ provider: 'google', email: 'user@example.com', emailVerified: false }), undefined);
  assert.equal(toTrustedEmailKey({ provider: 'apple', email: 'user@example.com' }), undefined);
});
