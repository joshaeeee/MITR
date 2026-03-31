import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeviceUsageSummary } from './device-usage-summary.js';

test('buildDeviceUsageSummary aggregates total and today usage by timezone', () => {
  const summary = buildDeviceUsageSummary(
    [
      {
        startedAt: new Date('2026-03-01T01:00:00.000Z'),
        endedAt: new Date('2026-03-01T01:10:00.000Z'),
        durationSec: 600
      },
      {
        startedAt: new Date('2026-02-28T17:00:00.000Z'),
        endedAt: new Date('2026-02-28T17:25:00.000Z'),
        durationSec: 1500
      }
    ],
    'Asia/Kolkata',
    new Date('2026-03-01T12:00:00.000Z')
  );

  assert.equal(summary.totalDurationSec, 2100);
  assert.equal(summary.todayDurationSec, 600);
  assert.equal(summary.sessionCount, 2);
  assert.equal(summary.todaySessionCount, 1);
  assert.equal(summary.lastSessionDurationSec, 600);
  assert.equal(summary.lastSessionStartedAt, new Date('2026-03-01T01:00:00.000Z').getTime());
  assert.equal(summary.lastSessionEndedAt, new Date('2026-03-01T01:10:00.000Z').getTime());
  assert.equal(summary.updatedAt, new Date('2026-03-01T01:10:00.000Z').getTime());
});

test('buildDeviceUsageSummary returns an empty summary when no sessions exist', () => {
  const summary = buildDeviceUsageSummary([], 'Asia/Kolkata', new Date('2026-03-01T12:00:00.000Z'));

  assert.equal(summary.totalDurationSec, 0);
  assert.equal(summary.todayDurationSec, 0);
  assert.equal(summary.sessionCount, 0);
  assert.equal(summary.todaySessionCount, 0);
  assert.equal(summary.lastSessionDurationSec, undefined);
  assert.equal(summary.lastSessionStartedAt, undefined);
  assert.equal(summary.lastSessionEndedAt, undefined);
  assert.equal(summary.updatedAt, new Date('2026-03-01T12:00:00.000Z').getTime());
});
