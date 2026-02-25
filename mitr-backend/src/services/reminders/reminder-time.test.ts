import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReminderDatetime } from './reminder-time.js';

test('validateReminderDatetime rejects invalid ISO string', () => {
  assert.throws(() => validateReminderDatetime('not-a-date', 1_000), /Invalid datetimeISO/);
});

test('validateReminderDatetime rejects past datetime', () => {
  assert.throws(() => validateReminderDatetime('1970-01-01T00:00:00.000Z', 10_000), /in the past/);
});

test('validateReminderDatetime returns positive delay for future datetime', () => {
  const result = validateReminderDatetime('1970-01-01T00:00:12.000Z', 10_000);
  assert.equal(result.fireAtMs, 12_000);
  assert.equal(result.delayMs, 2_000);
});
