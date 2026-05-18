import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mem0Service, mem0UserIdFor } from './mem0-service.js';

const withMem0Env = async (fn: () => Promise<void>) => {
  const previous = {
    MEM0_API_KEY: process.env.MEM0_API_KEY,
    MEM0_BASE_URL: process.env.MEM0_BASE_URL,
    MEM0_APP_ID: process.env.MEM0_APP_ID,
    MEM0_AGENT_ID: process.env.MEM0_AGENT_ID
  };
  process.env.MEM0_API_KEY = 'mem0-test';
  process.env.MEM0_BASE_URL = 'https://api.mem0.test';
  process.env.MEM0_APP_ID = 'mitr-test';
  process.env.MEM0_AGENT_ID = 'reca-test';
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test('mem0UserIdFor scopes memories to elder when available', () => {
  assert.equal(mem0UserIdFor('user-1', 'elder-1'), 'elder:elder-1');
  assert.equal(mem0UserIdFor('user-1'), 'user:user-1');
});

test('addScopedMemory calls Mem0 v3 add with elder user scope and registry metadata', async () => {
  await withMem0Env(async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url, init) => {
        assert.equal(String(url), 'https://api.mem0.test/v3/memories/add/');
        assert.equal(init?.method, 'POST');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.user_id, 'elder:elder-1');
        assert.equal(body.metadata.registryId, 'registry-1');
        assert.equal(body.metadata.mitrUserId, 'user-1');
        assert.equal(body.metadata.elderId, 'elder-1');
        assert.equal(body.metadata.appId, 'mitr-test');
        assert.equal(body.metadata.agentId, 'reca-test');
        assert.equal(body.infer, true);
        return new Response(
          JSON.stringify({
            status: 'PENDING',
            event_id: 'event-1',
            message: 'queued'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const service = new Mem0Service();
      const result = await service.addScopedMemory({
        userId: 'user-1',
        elderId: 'elder-1',
        messages: [{ role: 'user', content: 'I like morning walks.' }],
        metadata: { registryId: 'registry-1' }
      });

      assert.equal(result.status, 'PENDING');
      assert.equal(result.eventId, 'event-1');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('searchScopedMemories calls Mem0 v3 search with entity filters', async () => {
  await withMem0Env(async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url, init) => {
        assert.equal(String(url), 'https://api.mem0.test/v3/memories/search/');
        assert.equal(init?.method, 'POST');
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.filters, { user_id: 'elder:elder-1' });
        assert.equal(body.query, 'spiritual reading');
        assert.equal(body.top_k, 3);
        return new Response(
          JSON.stringify({
            results: [
              {
                id: 'mem-1',
                memory: 'User likes Ashtavakra Gita.',
                score: 0.8,
                metadata: { registryId: 'registry-1' },
                categories: ['spiritual_content']
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const service = new Mem0Service();
      const results = await service.searchScopedMemories({
        userId: 'user-1',
        elderId: 'elder-1',
        query: 'spiritual reading',
        limit: 3
      });

      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, 'mem-1');
      assert.equal(results[0]?.metadata.registryId, 'registry-1');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('listScopedMemories calls Mem0 v3 list with scoped filters', async () => {
  await withMem0Env(async () => {
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url, init) => {
        assert.equal(String(url), 'https://api.mem0.test/v3/memories/?page=2&page_size=10');
        assert.equal(init?.method, 'POST');
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.filters, { category: 'workout_log', user_id: 'elder:elder-1' });
        return new Response(
          JSON.stringify({
            count: 1,
            next: null,
            previous: null,
            results: [
              {
                id: 'mem-1',
                memory: 'Workout log: pushups.',
                user_id: 'elder:elder-1',
                metadata: { category: 'workout_log' },
                categories: []
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const service = new Mem0Service();
      const result = await service.listScopedMemories({
        userId: 'user-1',
        elderId: 'elder-1',
        filters: { category: 'workout_log' },
        limit: 10,
        page: 2
      });

      assert.equal(result.count, 1);
      assert.equal(result.memories[0]?.id, 'mem-1');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test('updateScopedMemory verifies scope before updating memory', async () => {
  await withMem0Env(async () => {
    const previousFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    try {
      globalThis.fetch = (async (url, init) => {
        calls.push({ url: String(url), init });
        if (calls.length === 1) {
          assert.equal(String(url), 'https://api.mem0.test/v1/memories/mem-1/');
          assert.equal(init?.method, 'GET');
          return new Response(
            JSON.stringify({
              id: 'mem-1',
              memory: 'Old plan',
              user_id: 'elder:elder-1',
              metadata: { mitrUserId: 'user-1', elderId: 'elder-1', category: 'fitness_plan' }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        assert.equal(String(url), 'https://api.mem0.test/v1/memories/mem-1/');
        assert.equal(init?.method, 'PUT');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.text, 'New plan');
        assert.equal(body.metadata.category, 'fitness_plan');
        assert.equal(body.metadata.status, 'active');
        assert.equal(body.metadata.mitrUserId, 'user-1');
        return new Response(
          JSON.stringify({
            id: 'mem-1',
            text: 'New plan',
            user_id: 'elder:elder-1',
            metadata: body.metadata
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const service = new Mem0Service();
      const memory = await service.updateScopedMemory({
        userId: 'user-1',
        elderId: 'elder-1',
        memoryId: 'mem-1',
        text: 'New plan',
        metadata: { status: 'active' }
      });

      assert.equal(memory.memory, 'New plan');
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
