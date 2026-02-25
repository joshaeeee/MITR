import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncFollowupManager } from './async-followup-manager.js';

test('AsyncFollowupManager flushes scheduled followup when eligible', async () => {
  const sent: string[] = [];
  const manager = new AsyncFollowupManager({ delayMs: 5 });

  manager.schedule({
    type: 'news',
    requestId: 'n1',
    payload: { value: 'alpha' },
    buildInstructions: (payload) => `news:${String(payload.value)}`
  });

  manager.flushEligible(
    {
      generateReply: ({ instructions }) => sent.push(instructions)
    },
    () => true
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(sent, ['news:alpha']);
});

test('AsyncFollowupManager clear(type) cancels pending followup', async () => {
  const sent: string[] = [];
  const manager = new AsyncFollowupManager({ delayMs: 5 });

  manager.schedule({
    type: 'story',
    requestId: 's1',
    payload: { value: 'beta' },
    buildInstructions: (payload) => `story:${String(payload.value)}`
  });

  manager.flushEligible(
    {
      generateReply: ({ instructions }) => sent.push(instructions)
    },
    () => true
  );

  manager.clear('story');

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(sent, []);
});

test('AsyncFollowupManager uses latest scheduled payload for same type', async () => {
  const sent: string[] = [];
  const manager = new AsyncFollowupManager({ delayMs: 5 });

  manager.schedule({
    type: 'religious',
    requestId: 'r1',
    payload: { value: 'first' },
    buildInstructions: (payload) => `religious:${String(payload.value)}`
  });

  manager.flushEligible(
    {
      generateReply: ({ instructions }) => sent.push(instructions)
    },
    () => true
  );

  manager.schedule({
    type: 'religious',
    requestId: 'r2',
    payload: { value: 'latest' },
    buildInstructions: (payload) => `religious:${String(payload.value)}`
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(sent, ['religious:latest']);
});
