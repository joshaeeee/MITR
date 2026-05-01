import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePersistentAgentDispatch, normalizeWakeId } from './device-agent-lifecycle.js';

test('normalizeWakeId trims valid IDs and rejects empty values', () => {
  assert.equal(normalizeWakeId(' wake-1 '), 'wake-1');
  assert.equal(normalizeWakeId('   '), null);
  assert.equal(normalizeWakeId(undefined), null);
});

test('decidePersistentAgentDispatch dispatches missing, failed, timed-out, and stale agents', () => {
  const nowMs = 10_000;
  const base = { nowMs, readyTimeoutMs: 3_000, staleMs: 5_000 };

  assert.deepEqual(decidePersistentAgentDispatch({ ...base, agentState: 'not_dispatched', agentLastSeenAtMs: null }), {
    shouldDispatch: true,
    reason: 'not_dispatched'
  });
  assert.deepEqual(decidePersistentAgentDispatch({ ...base, agentState: 'failed', agentLastSeenAtMs: 9_000 }), {
    shouldDispatch: true,
    reason: 'failed'
  });
  assert.deepEqual(decidePersistentAgentDispatch({ ...base, agentState: 'dispatching', agentLastSeenAtMs: 6_000 }), {
    shouldDispatch: true,
    reason: 'dispatch_timeout'
  });
  assert.deepEqual(decidePersistentAgentDispatch({ ...base, agentState: 'ready', agentLastSeenAtMs: 4_000 }), {
    shouldDispatch: true,
    reason: 'ready_stale'
  });
});

test('decidePersistentAgentDispatch does not duplicate healthy agent dispatches', () => {
  const base = { nowMs: 10_000, readyTimeoutMs: 3_000, staleMs: 5_000 };

  assert.deepEqual(decidePersistentAgentDispatch({ ...base, agentState: 'dispatching', agentLastSeenAtMs: 8_000 }), {
    shouldDispatch: false,
    reason: 'dispatching'
  });
  assert.deepEqual(decidePersistentAgentDispatch({ ...base, agentState: 'ready', agentLastSeenAtMs: 9_000 }), {
    shouldDispatch: false,
    reason: 'ready'
  });
});
