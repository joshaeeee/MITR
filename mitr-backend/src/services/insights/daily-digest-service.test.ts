import test from 'node:test';
import assert from 'node:assert/strict';
import { isInsufficientConfidence } from './daily-digest-service.js';

test('isInsufficientConfidence returns true when confidence is below threshold', () => {
  assert.equal(isInsufficientConfidence(44, 90), true);
});

test('isInsufficientConfidence returns true when data sufficiency is below threshold', () => {
  assert.equal(isInsufficientConfidence(90, 34), true);
});

test('isInsufficientConfidence returns false when both are sufficient', () => {
  assert.equal(isInsufficientConfidence(70, 70), false);
});

