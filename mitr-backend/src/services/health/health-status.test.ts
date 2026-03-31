import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApiHealthStatus } from './health-status.js';

test('health status stays ok when optional dependencies are not configured', () => {
  const health = buildApiHealthStatus(
    {
      postgres: {
        status: 'ok',
        required: true,
        configured: true,
        durationMs: 8
      },
      redis: {
        status: 'not_configured',
        required: false,
        configured: false,
        durationMs: 0
      },
      reminderQueue: {
        status: 'not_configured',
        required: false,
        configured: false,
        durationMs: 0
      }
    },
    new Date('2026-03-20T00:00:00.000Z'),
    42
  );

  assert.equal(health.ok, true);
  assert.equal(health.service, 'mitr-api');
  assert.equal(health.timestamp, '2026-03-20T00:00:00.000Z');
  assert.equal(health.uptimeSec, 42);
});

test('health status fails when a required dependency is degraded', () => {
  const health = buildApiHealthStatus(
    {
      postgres: {
        status: 'error',
        required: true,
        configured: true,
        durationMs: 3001,
        detail: 'postgres timed out after 3000ms'
      },
      redis: {
        status: 'ok',
        required: true,
        configured: true,
        durationMs: 12
      },
      reminderQueue: {
        status: 'ok',
        required: true,
        configured: true,
        durationMs: 7,
        metrics: {
          waiting: 1,
          active: 0,
          delayed: 2,
          failed: 0,
          completed: 10
        }
      }
    },
    new Date('2026-03-20T00:00:00.000Z'),
    42
  );

  assert.equal(health.ok, false);
  assert.equal(health.dependencies.postgres.detail, 'postgres timed out after 3000ms');
  assert.equal(health.dependencies.reminderQueue.metrics?.completed, 10);
});
