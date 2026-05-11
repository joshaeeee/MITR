import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePasswordPolicy } from './password-policy.js';

test('password policy accepts a strong password', () => {
  assert.deepEqual(
    validatePasswordPolicy({
      email: 'family@example.com',
      name: 'Nidhi Joshi',
      password: 'Mandir#River42'
    }),
    { ok: true }
  );
});

test('password policy rejects short and common passwords', () => {
  assert.equal(validatePasswordPolicy({ password: 'Short#1' }).ok, false);
  assert.equal(validatePasswordPolicy({ password: 'password1234' }).ok, false);
});

test('password policy rejects low variety and obvious sequences', () => {
  assert.equal(validatePasswordPolicy({ password: 'alllowercasepassword' }).ok, false);
  assert.equal(validatePasswordPolicy({ password: 'Abc123456789!' }).ok, false);
});

test('password policy rejects user-identifying passwords', () => {
  assert.equal(
    validatePasswordPolicy({
      email: 'shivansh@example.com',
      password: 'Shivansh#2026'
    }).ok,
    false
  );
  assert.equal(
    validatePasswordPolicy({
      name: 'Nidhi Joshi',
      password: 'Nidhi#Secure42'
    }).ok,
    false
  );
});
