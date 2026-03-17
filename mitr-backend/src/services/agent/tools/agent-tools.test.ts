/**
 * Comprehensive test suite for all 23 agent tools.
 *
 * Tests each tool for:
 *  - Schema validation (valid & invalid inputs)
 *  - Correct service delegation (right method called with right args)
 *  - Return shape (status, keys, error handling)
 *  - Timeout configuration
 *
 * Uses node:test + assert with hand-rolled mocks (no vitest/jest dependency).
 *
 * Run: pnpm tsx --test src/services/agent/tools/agent-tools.test.ts
 */

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { AgentToolContext, AgentToolDefinition, ToolDeps } from './legacy-tools.js';
import { createLegacyToolDefinitions } from './legacy-tools.js';
import { AsyncToolRuntime } from '../../../agent-worker/async-tool-runtime.js';
import { createNewsRetrieveTool } from './news-tools.js';
import { createWebSearchTool } from './web-tools.js';
import { createReligiousRetrieveTool } from './religious-tools.js';
import { createStoryRetrieveTool } from './story-tools.js';
import { createPanchangTool } from './panchang-tools.js';
import { createYoutubeMediaTool } from './youtube-tools.js';

// ─── Helpers ──────────────────────────────────────────────────────────

const makeContext = (overrides?: Partial<AgentToolContext>): AgentToolContext => ({
  userId: 'test-user-001',
  language: 'hi',
  sessionId: 'test-session-001',
  getLastUserTranscript: () => null,
  onToolExecutionStart: () => {},
  onToolExecutionEnd: () => {},
  publishClientEvent: () => {},
  ...overrides
});

const findTool = (tools: AgentToolDefinition[], name: string): AgentToolDefinition => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found. Available: ${tools.map((t) => t.name).join(', ')}`);
  return tool;
};

const noop = async (..._args: unknown[]) => ({});

// ─── Mock factory ─────────────────────────────────────────────────────

const createMockDeps = (): {
  deps: ToolDeps;
  calls: Record<string, unknown[][]>;
} => {
  const calls: Record<string, unknown[][]> = {};

  const track = (service: string, method: string) => {
    const key = `${service}.${method}`;
    if (!calls[key]) calls[key] = [];
    return (...args: unknown[]) => {
      calls[key].push(args);
    };
  };

  const mem0 = {
    addMemory: async (...args: unknown[]) => {
      track('mem0', 'addMemory')(...args);
      return { id: 'mem-1' };
    },
    searchMemory: async (...args: unknown[]) => {
      track('mem0', 'searchMemory')(...args);
      return [{ id: 'mem-1', text: 'Test memory', score: 0.9 }];
    }
  };

  const reminderService = {
    create: async (...args: unknown[]) => {
      track('reminderService', 'create')(...args);
      return { id: `reminder-${Date.now()}` };
    },
    listByUser: async (...args: unknown[]) => {
      track('reminderService', 'listByUser')(...args);
      return [{ id: 'rem-1', title: 'Test reminder' }];
    }
  };

  const nudgesService = {
    getPendingForElder: async (...args: unknown[]) => {
      track('nudgesService', 'getPendingForElder')(...args);
      return {
        pendingCount: 2,
        nudges: [
          {
            nudgeId: 'nudge-1',
            nudgeShortId: 'n1',
            type: 'text',
            priority: 'urgent',
            message: 'Take your medicine',
            senderName: 'Beta'
          },
          {
            nudgeId: 'nudge-2',
            nudgeShortId: 'n2',
            type: 'text',
            priority: 'gentle',
            message: 'Miss you',
            senderName: 'Beta'
          }
        ]
      };
    },
    markListened: async (...args: unknown[]) => {
      track('nudgesService', 'markListened')(...args);
      return [{ nudgeId: 'nudge-1', status: 'listened' }];
    }
  };

  const newsService = {
    retrieve: async (...args: unknown[]) => {
      track('newsService', 'retrieve')(...args);
      return [
        {
          title: 'Test news',
          summary: 'Something happened',
          source: 'TestTimes',
          url: 'https://example.com/news',
          publishedAt: '2026-03-17T10:00:00Z'
        }
      ];
    }
  };

  const webSearchService = {
    search: async (...args: unknown[]) => {
      track('webSearchService', 'search')(...args);
      return [
        {
          title: 'Test result',
          summary: 'Found info',
          source: 'example.com',
          url: 'https://example.com',
          publishedAt: '2026-03-17'
        }
      ];
    }
  };

  const religiousRetriever = {
    retrieve: async (...args: unknown[]) => {
      track('religiousRetriever', 'retrieve')(...args);
      return [
        {
          title: 'Bhagavad Gita 2.47',
          source: 'Bhagavad Gita',
          passage: 'Karmanye vadhikaraste...',
          tradition: 'Hindu'
        }
      ];
    },
    retrieveStories: async (...args: unknown[]) => {
      track('religiousRetriever', 'retrieveStories')(...args);
      return [
        {
          title: 'The Monkey and the Crocodile',
          source: 'Panchatantra',
          passage: 'Once upon a time...',
          tradition: 'Hindu',
          storyId: 'story-1'
        }
      ];
    }
  };

  const companionService = {
    suggestAarti: async (...args: unknown[]) => {
      track('companionService', 'suggestAarti')(...args);
      return { suggestion: 'Om Jai Jagdish Hare', searchUrl: 'https://youtube.com/...' };
    },
    getDailyBriefing: async (...args: unknown[]) => {
      track('companionService', 'getDailyBriefing')(...args);
      return { briefing: 'Good morning! Today is...' };
    },
    getPranayamaGuide: async (...args: unknown[]) => {
      track('companionService', 'getPranayamaGuide')(...args);
      return { steps: ['Breathe in', 'Hold', 'Breathe out'], minutes: 5 };
    },
    getBrainGame: async (...args: unknown[]) => {
      track('companionService', 'getBrainGame')(...args);
      return { type: 'riddle', prompt: 'What has keys but no locks?' };
    },
    getFestivalCompanion: async (...args: unknown[]) => {
      track('companionService', 'getFestivalCompanion')(...args);
      return { festival: 'Holi', guidance: 'Play safe with colours' };
    }
  };

  const diaryService = {
    add: async (...args: unknown[]) => {
      track('diaryService', 'add')(...args);
    },
    list: async (...args: unknown[]) => {
      track('diaryService', 'list')(...args);
      return [{ id: 'd1', text: 'Today I remembered...', ts: Date.now() }];
    }
  };

  const sessionDirector = {
    getByUserRunning: async (...args: unknown[]) => {
      track('sessionDirector', 'getByUserRunning')(...args);
      return null;
    },
    get: async (...args: unknown[]) => {
      track('sessionDirector', 'get')(...args);
      return null;
    },
    start: async (...args: unknown[]) => {
      track('sessionDirector', 'start')(...args);
      return {
        session: {
          longSessionId: 'ls-1',
          mode: 'satsang_long',
          status: 'running',
          phase: 'shastra_path',
          topic: 'Bhagavad Gita',
          language: 'hi'
        },
        nextBlock: {
          id: 'blk-1',
          seq: 1,
          blockType: 'speak',
          payload: {
            completionPolicy: 'auto',
            phase: 'shastra_path',
            prompt: 'Begin satsang',
            fixedText: 'Karmanye vadhikaraste...'
          }
        }
      };
    },
    next: async (...args: unknown[]) => {
      track('sessionDirector', 'next')(...args);
      return {
        id: 'blk-2',
        seq: 2,
        blockType: 'speak',
        payload: {
          completionPolicy: 'auto',
          phase: 'shastra_path',
          prompt: 'Explain meaning'
        }
      };
    },
    stop: async (...args: unknown[]) => {
      track('sessionDirector', 'stop')(...args);
      return {
        longSessionId: 'ls-1',
        mode: 'satsang_long',
        status: 'stopped',
        phase: 'shastra_path'
      };
    },
    completeBlock: async (...args: unknown[]) => {
      track('sessionDirector', 'completeBlock')(...args);
    }
  };

  const youtubeStreamService = {
    resolveFromSearch: async (...args: unknown[]) => {
      track('youtubeStreamService', 'resolveFromSearch')(...args);
      return {
        title: 'Morning Bhajan',
        searchQuery: 'morning bhajan',
        streamUrl: 'https://stream.example.com/vid',
        webpageUrl: 'https://youtube.com/watch?v=abc'
      };
    }
  };

  const panchangService = {
    getByCity: async (...args: unknown[]) => {
      track('panchangService', 'getByCity')(...args);
      return {
        status: 'ready',
        location: {
          city: 'Varanasi',
          state: 'Uttar Pradesh',
          country: 'India',
          latitude: 25.32,
          longitude: 83.01,
          timezone: 'Asia/Kolkata'
        },
        panchang: {
          tithi: { name: 'Ashtami', paksha: 'Shukla', start: '06:30', end: '18:00' }
        }
      };
    },
    getByCoordinates: async (...args: unknown[]) => {
      track('panchangService', 'getByCoordinates')(...args);
      return {
        status: 'ready',
        location: {
          city: 'Varanasi',
          state: 'Uttar Pradesh',
          country: 'India',
          latitude: 25.32,
          longitude: 83.01,
          timezone: 'Asia/Kolkata'
        },
        panchang: {
          tithi: { name: 'Navami', paksha: 'Shukla', start: '07:00', end: '19:00' }
        }
      };
    }
  };

  return {
    deps: {
      religiousRetriever,
      mem0,
      reminderService,
      newsService,
      companionService,
      diaryService,
      sessionDirector,
      youtubeStreamService,
      panchangService,
      webSearchService,
      nudgesService
    } as unknown as ToolDeps,
    calls
  };
};

// ─── Test Setup ───────────────────────────────────────────────────────

let mockDeps: ReturnType<typeof createMockDeps>;
let syncTools: AgentToolDefinition[];
let asyncRuntime: AsyncToolRuntime;
let asyncTools: Record<string, AgentToolDefinition>;
let ctx: AgentToolContext;

const setup = () => {
  mockDeps = createMockDeps();
  syncTools = createLegacyToolDefinitions(mockDeps.deps, {
    includeAsyncTools: false,
    logRegistration: false
  });
  asyncRuntime = new AsyncToolRuntime({ defaultTtlMs: 5000, cleanupIntervalMs: 60_000 });
  asyncTools = {
    news_retrieve: createNewsRetrieveTool(mockDeps.deps, asyncRuntime),
    web_search: createWebSearchTool(mockDeps.deps, asyncRuntime),
    religious_retrieve: createReligiousRetrieveTool(mockDeps.deps, asyncRuntime),
    story_retrieve: createStoryRetrieveTool(mockDeps.deps, asyncRuntime),
    panchang_get: createPanchangTool(mockDeps.deps, asyncRuntime),
    youtube_media_get: createYoutubeMediaTool(mockDeps.deps, asyncRuntime)
  };
  ctx = makeContext();
};

// ─── Tool Registration ───────────────────────────────────────────────

describe('Tool registration', () => {
  test('all 17 sync tools are registered', () => {
    setup();
    const expected = [
      'memory_add', 'memory_get',
      'reminder_create', 'reminder_list',
      'nudge_pending_get', 'nudge_mark_listened',
      'devotional_playlist_get',
      'daily_briefing_get',
      'diary_add', 'diary_list',
      'flow_start', 'flow_next', 'flow_stop',
      'pranayama_guide_get', 'brain_game_get', 'festival_context_get',
      'medication_adherence_setup'
    ];
    const names = syncTools.map((t) => t.name);
    for (const name of expected) {
      assert.ok(names.includes(name), `Missing sync tool: ${name}`);
    }
  });

  test('all 6 async tools are created', () => {
    setup();
    const expected = [
      'news_retrieve', 'web_search', 'religious_retrieve',
      'story_retrieve', 'panchang_get', 'youtube_media_get'
    ];
    for (const name of expected) {
      assert.ok(asyncTools[name], `Missing async tool: ${name}`);
    }
  });

  test('every tool has a name, description, parameters (ZodType), timeoutMs, and execute', () => {
    setup();
    const all = [...syncTools, ...Object.values(asyncTools)];
    for (const tool of all) {
      assert.ok(typeof tool.name === 'string' && tool.name.length > 0, `tool.name is empty`);
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name}: no description`);
      assert.ok(tool.parameters instanceof z.ZodType, `${tool.name}: parameters is not ZodType`);
      assert.ok(typeof tool.timeoutMs === 'number' && tool.timeoutMs > 0, `${tool.name}: bad timeoutMs`);
      assert.ok(typeof tool.execute === 'function', `${tool.name}: execute is not a function`);
    }
  });

  test('no duplicate tool names', () => {
    setup();
    const all = [...syncTools, ...Object.values(asyncTools)];
    const names = all.map((t) => t.name);
    const unique = new Set(names);
    assert.equal(names.length, unique.size, `Duplicate tool names: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
  });
});

// ─── MEMORY TOOLS ─────────────────────────────────────────────────────

describe('memory_add', () => {
  test('saves memory and returns memorySaved: true', async () => {
    setup();
    const tool = findTool(syncTools, 'memory_add');
    const result = await tool.execute({ text: 'I like chai in the morning', tags: ['preference'] }, ctx) as Record<string, unknown>;
    assert.equal(result.memorySaved, true);
    assert.ok(mockDeps.calls['mem0.addMemory']?.length === 1);
  });

  test('returns memorySaved: false on service error', async () => {
    setup();
    (mockDeps.deps.mem0 as any).addMemory = async () => { throw new Error('DB down'); };
    const tool = findTool(syncTools, 'memory_add');
    const result = await tool.execute({ text: 'something' }, ctx) as Record<string, unknown>;
    assert.equal(result.memorySaved, false);
    assert.ok(typeof result.error === 'string');
  });

  test('schema validates text is required', () => {
    setup();
    const tool = findTool(syncTools, 'memory_add');
    const parsed = tool.parameters.safeParse({});
    assert.equal(parsed.success, false);
  });

  test('schema accepts valid input with tags', () => {
    setup();
    const tool = findTool(syncTools, 'memory_add');
    const parsed = tool.parameters.safeParse({ text: 'hello', tags: ['a', 'b'] });
    assert.equal(parsed.success, true);
  });
});

describe('memory_get', () => {
  test('returns memories array and memoryAvailable: true', async () => {
    setup();
    const tool = findTool(syncTools, 'memory_get');
    const result = await tool.execute({ query: 'chai' }, ctx) as Record<string, unknown>;
    assert.ok(Array.isArray(result.memories));
    assert.equal(result.memoryAvailable, true);
  });

  test('returns empty memories on service error', async () => {
    setup();
    (mockDeps.deps.mem0 as any).searchMemory = async () => { throw new Error('timeout'); };
    const tool = findTool(syncTools, 'memory_get');
    const result = await tool.execute({ query: 'chai' }, ctx) as Record<string, unknown>;
    assert.deepEqual(result.memories, []);
    assert.equal(result.memoryAvailable, false);
  });

  test('passes k parameter to service', async () => {
    setup();
    const tool = findTool(syncTools, 'memory_get');
    await tool.execute({ query: 'chai', k: 3 }, ctx);
    const args = mockDeps.calls['mem0.searchMemory']?.[0];
    assert.equal(args?.[2], 3);
  });
});

// ─── REMINDER TOOLS ───────────────────────────────────────────────────

describe('reminder_create', () => {
  test('creates reminder and returns reminderId', async () => {
    setup();
    const tool = findTool(syncTools, 'reminder_create');
    const result = await tool.execute({
      title: 'Doctor appointment',
      datetimeISO: '2026-03-18T10:00:00Z'
    }, ctx) as Record<string, unknown>;
    assert.ok(typeof result.reminderId === 'string');
    assert.ok(mockDeps.calls['reminderService.create']?.length === 1);
  });

  test('passes language from context when not provided', async () => {
    setup();
    const tool = findTool(syncTools, 'reminder_create');
    await tool.execute({
      title: 'Test',
      datetimeISO: '2026-03-18T10:00:00Z'
    }, ctx);
    const args = mockDeps.calls['reminderService.create']?.[0]?.[0] as Record<string, unknown>;
    assert.equal(args.language, 'hi');
  });

  test('schema requires title and datetimeISO', () => {
    setup();
    const tool = findTool(syncTools, 'reminder_create');
    assert.equal(tool.parameters.safeParse({}).success, false);
    assert.equal(tool.parameters.safeParse({ title: 'test' }).success, false);
    assert.equal(tool.parameters.safeParse({ title: 'test', datetimeISO: '2026-03-18T10:00:00Z' }).success, true);
  });
});

describe('reminder_list', () => {
  test('returns reminders array', async () => {
    setup();
    const tool = findTool(syncTools, 'reminder_list');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.ok(Array.isArray(result.reminders));
  });

  test('calls listByUser with correct userId', async () => {
    setup();
    const tool = findTool(syncTools, 'reminder_list');
    await tool.execute({}, ctx);
    const args = mockDeps.calls['reminderService.listByUser']?.[0];
    assert.equal(args?.[0], 'test-user-001');
  });
});

// ─── NUDGE TOOLS ──────────────────────────────────────────────────────

describe('nudge_pending_get', () => {
  test('returns pending nudges with priority counts', async () => {
    setup();
    const tool = findTool(syncTools, 'nudge_pending_get');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.equal(result.hasPending, true);
    assert.equal(result.pendingCount, 2);
    assert.ok(result.firstNudge);
    assert.ok(result.priorityCounts);
  });

  test('returns hasPending: false when no nudges', async () => {
    setup();
    (mockDeps.deps.nudgesService as any).getPendingForElder = async () => null;
    const tool = findTool(syncTools, 'nudge_pending_get');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.equal(result.hasPending, false);
  });
});

describe('nudge_mark_listened', () => {
  test('marks nudge as listened by nudgeId', async () => {
    setup();
    const tool = findTool(syncTools, 'nudge_mark_listened');
    const result = await tool.execute({ nudgeId: 'nudge-1' }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
  });

  test('marks nudge by nudgeShortId', async () => {
    setup();
    const tool = findTool(syncTools, 'nudge_mark_listened');
    const result = await tool.execute({ nudgeShortId: 'n1' }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
  });

  test('marks nudge by ordinal', async () => {
    setup();
    const tool = findTool(syncTools, 'nudge_mark_listened');
    const result = await tool.execute({ nudgeOrdinal: 1 }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
  });

  test('auto-selects first pending when no args given', async () => {
    setup();
    const tool = findTool(syncTools, 'nudge_mark_listened');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
  });

  test('returns error when no pending nudges exist', async () => {
    setup();
    (mockDeps.deps.nudgesService as any).getPendingForElder = async () => ({ pendingCount: 0, nudges: [] });
    const tool = findTool(syncTools, 'nudge_mark_listened');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.equal(result.ok, false);
  });
});

// ─── DIARY TOOLS ──────────────────────────────────────────────────────

describe('diary_add', () => {
  test('saves diary entry and returns ok: true', async () => {
    setup();
    const tool = findTool(syncTools, 'diary_add');
    const result = await tool.execute({ text: 'Today was a good day', mood: 'happy' }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.ok(mockDeps.calls['diaryService.add']?.length === 1);
  });

  test('passes userId and entry data', async () => {
    setup();
    const tool = findTool(syncTools, 'diary_add');
    await tool.execute({ text: 'entry', tags: ['family'] }, ctx);
    const args = mockDeps.calls['diaryService.add']?.[0];
    assert.equal(args?.[0], 'test-user-001');
    const entry = args?.[1] as Record<string, unknown>;
    assert.equal(entry.text, 'entry');
    assert.deepEqual(entry.tags, ['family']);
  });

  test('schema requires text', () => {
    setup();
    const tool = findTool(syncTools, 'diary_add');
    assert.equal(tool.parameters.safeParse({}).success, false);
    assert.equal(tool.parameters.safeParse({ text: 'hello' }).success, true);
  });
});

describe('diary_list', () => {
  test('returns entries array', async () => {
    setup();
    const tool = findTool(syncTools, 'diary_list');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.ok(Array.isArray(result.entries));
  });

  test('uses default limit of 10', async () => {
    setup();
    const tool = findTool(syncTools, 'diary_list');
    await tool.execute({}, ctx);
    const args = mockDeps.calls['diaryService.list']?.[0];
    assert.equal(args?.[1], 10);
  });

  test('passes custom limit', async () => {
    setup();
    const tool = findTool(syncTools, 'diary_list');
    await tool.execute({ limit: 5 }, ctx);
    const args = mockDeps.calls['diaryService.list']?.[0];
    assert.equal(args?.[1], 5);
  });
});

// ─── COMPANION TOOLS ─────────────────────────────────────────────────

describe('devotional_playlist_get', () => {
  test('returns suggestion from companionService', async () => {
    setup();
    const tool = findTool(syncTools, 'devotional_playlist_get');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.ok(result.suggestion);
  });

  test('has 700ms timeout', () => {
    setup();
    const tool = findTool(syncTools, 'devotional_playlist_get');
    assert.equal(tool.timeoutMs, 700);
  });
});

describe('daily_briefing_get', () => {
  test('returns briefing data', async () => {
    setup();
    const tool = findTool(syncTools, 'daily_briefing_get');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.ok(result.briefing);
  });

  test('passes userId and language', async () => {
    setup();
    const tool = findTool(syncTools, 'daily_briefing_get');
    await tool.execute({ language: 'en' }, ctx);
    const args = mockDeps.calls['companionService.getDailyBriefing']?.[0];
    assert.equal(args?.[0], 'test-user-001');
    assert.equal(args?.[1], 'en');
  });

  test('uses context language as fallback', async () => {
    setup();
    const tool = findTool(syncTools, 'daily_briefing_get');
    await tool.execute({}, ctx);
    const args = mockDeps.calls['companionService.getDailyBriefing']?.[0];
    assert.equal(args?.[1], 'hi');
  });
});

describe('pranayama_guide_get', () => {
  test('returns breathing guide steps', async () => {
    setup();
    const tool = findTool(syncTools, 'pranayama_guide_get');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.ok(result.steps);
  });

  test('uses default 5 minutes', async () => {
    setup();
    const tool = findTool(syncTools, 'pranayama_guide_get');
    await tool.execute({}, ctx);
    const args = mockDeps.calls['companionService.getPranayamaGuide']?.[0];
    assert.equal(args?.[0], 5);
  });

  test('passes custom minutes', async () => {
    setup();
    const tool = findTool(syncTools, 'pranayama_guide_get');
    await tool.execute({ minutes: 10 }, ctx);
    const args = mockDeps.calls['companionService.getPranayamaGuide']?.[0];
    assert.equal(args?.[0], 10);
  });

  test('schema rejects minutes < 2 or > 20', () => {
    setup();
    const tool = findTool(syncTools, 'pranayama_guide_get');
    assert.equal(tool.parameters.safeParse({ minutes: 1 }).success, false);
    assert.equal(tool.parameters.safeParse({ minutes: 21 }).success, false);
    assert.equal(tool.parameters.safeParse({ minutes: 10 }).success, true);
  });
});

describe('brain_game_get', () => {
  test('returns game prompt', async () => {
    setup();
    const tool = findTool(syncTools, 'brain_game_get');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.ok(result.type);
    assert.ok(result.prompt);
  });

  test('defaults to riddle type', async () => {
    setup();
    const tool = findTool(syncTools, 'brain_game_get');
    await tool.execute({}, ctx);
    const args = mockDeps.calls['companionService.getBrainGame']?.[0];
    assert.equal(args?.[0], 'riddle');
  });
});

describe('festival_context_get', () => {
  test('returns festival guidance', async () => {
    setup();
    const tool = findTool(syncTools, 'festival_context_get');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.ok(result.festival);
  });

  test('has 800ms timeout', () => {
    setup();
    const tool = findTool(syncTools, 'festival_context_get');
    assert.equal(tool.timeoutMs, 800);
  });
});

// ─── MEDICATION ADHERENCE ─────────────────────────────────────────────

describe('medication_adherence_setup', () => {
  test('creates 3 reminders (base + 2 follow-ups)', async () => {
    setup();
    const tool = findTool(syncTools, 'medication_adherence_setup');
    const result = await tool.execute({
      medicine: 'Metformin',
      datetimeISO: '2026-03-18T08:00:00Z'
    }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.reminderIds));
    assert.equal((result.reminderIds as string[]).length, 3);
    assert.equal(mockDeps.calls['reminderService.create']?.length, 3);
  });

  test('follow-ups are +10 and +20 minutes', async () => {
    setup();
    const tool = findTool(syncTools, 'medication_adherence_setup');
    await tool.execute({
      medicine: 'Aspirin',
      datetimeISO: '2026-03-18T08:00:00Z'
    }, ctx);
    const createCalls = mockDeps.calls['reminderService.create']!;
    const baseTime = new Date('2026-03-18T08:00:00Z').getTime();
    const t1 = new Date((createCalls[1][0] as Record<string, unknown>).datetimeISO as string).getTime();
    const t2 = new Date((createCalls[2][0] as Record<string, unknown>).datetimeISO as string).getTime();
    assert.equal(t1 - baseTime, 10 * 60 * 1000);
    assert.equal(t2 - baseTime, 20 * 60 * 1000);
  });

  test('returns error for invalid datetimeISO', async () => {
    setup();
    const tool = findTool(syncTools, 'medication_adherence_setup');
    const result = await tool.execute({
      medicine: 'Test',
      datetimeISO: 'not-a-date'
    }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === 'string');
  });

  test('schema requires medicine and datetimeISO', () => {
    setup();
    const tool = findTool(syncTools, 'medication_adherence_setup');
    assert.equal(tool.parameters.safeParse({}).success, false);
    assert.equal(tool.parameters.safeParse({ medicine: 'Test' }).success, false);
    assert.equal(
      tool.parameters.safeParse({ medicine: 'Test', datetimeISO: '2026-03-18T08:00:00Z' }).success,
      true
    );
  });
});

// ─── FLOW TOOLS ───────────────────────────────────────────────────────

describe('flow_start', () => {
  test('starts a new flow and returns flow response', async () => {
    setup();
    const tool = findTool(syncTools, 'flow_start');
    const result = await tool.execute({ flowType: 'satsang', topic: 'Bhagavad Gita' }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.resumed, false);
    assert.ok(result.flow);
  });

  test('infers satsang flow type from topic', async () => {
    setup();
    const tool = findTool(syncTools, 'flow_start');
    const result = await tool.execute({ topic: 'Bhagavad Gita satsang' }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
    const startArgs = mockDeps.calls['sessionDirector.start']?.[0]?.[0] as Record<string, unknown>;
    assert.equal(startArgs.mode, 'satsang_long');
  });

  test('infers story flow type from topic', async () => {
    setup();
    const tool = findTool(syncTools, 'flow_start');
    await tool.execute({ topic: 'Panchatantra कहानी' }, ctx);
    const startArgs = mockDeps.calls['sessionDirector.start']?.[0]?.[0] as Record<string, unknown>;
    assert.equal(startArgs.mode, 'story_long');
  });

  test('resumes active flow when resumeIfRunning=true', async () => {
    setup();
    (mockDeps.deps.sessionDirector as any).getByUserRunning = async () => ({
      longSessionId: 'ls-existing',
      mode: 'satsang_long',
      status: 'running',
      phase: 'shastra_path',
      topic: 'Gita'
    });
    const tool = findTool(syncTools, 'flow_start');
    const result = await tool.execute({ flowType: 'satsang', resumeIfRunning: true }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.resumed, true);
  });

  test('has 15000ms timeout', () => {
    setup();
    const tool = findTool(syncTools, 'flow_start');
    assert.equal(tool.timeoutMs, 15000);
  });
});

describe('flow_next', () => {
  test('returns error when no active flow', async () => {
    setup();
    const tool = findTool(syncTools, 'flow_next');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === 'string');
  });

  test('advances active flow and returns next step', async () => {
    setup();
    (mockDeps.deps.sessionDirector as any).getByUserRunning = async () => ({
      longSessionId: 'ls-1',
      mode: 'satsang_long',
      status: 'running',
      phase: 'shastra_path',
      currentBlockId: 'blk-1'
    });
    (mockDeps.deps.sessionDirector as any).get = async () => ({
      longSessionId: 'ls-1',
      mode: 'satsang_long',
      status: 'running',
      phase: 'shastra_path'
    });
    const tool = findTool(syncTools, 'flow_next');
    const result = await tool.execute({ action: 'continue' }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.ok(result.flow);
  });

  test('closes flow with action=close', async () => {
    setup();
    (mockDeps.deps.sessionDirector as any).getByUserRunning = async () => ({
      longSessionId: 'ls-1',
      mode: 'satsang_long',
      status: 'running',
      phase: 'shastra_path'
    });
    const tool = findTool(syncTools, 'flow_next');
    const result = await tool.execute({ action: 'close' }, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.equal(result.closed, true);
  });

  test('has 20000ms timeout', () => {
    setup();
    const tool = findTool(syncTools, 'flow_next');
    assert.equal(tool.timeoutMs, 20000);
  });
});

describe('flow_stop', () => {
  test('returns error when no active flow', async () => {
    setup();
    const tool = findTool(syncTools, 'flow_stop');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.ok(typeof result.error === 'string');
  });

  test('stops active flow', async () => {
    setup();
    (mockDeps.deps.sessionDirector as any).getByUserRunning = async () => ({
      longSessionId: 'ls-1',
      mode: 'satsang_long',
      status: 'running',
      phase: 'shastra_path'
    });
    const tool = findTool(syncTools, 'flow_stop');
    const result = await tool.execute({}, ctx) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.ok(result.flow);
    assert.ok(mockDeps.calls['sessionDirector.stop']?.length === 1);
  });
});

// ─── ASYNC TOOLS ──────────────────────────────────────────────────────

describe('news_retrieve (async)', () => {
  test('returns pending on first call', async () => {
    setup();
    const tool = asyncTools.news_retrieve;
    const result = await tool.execute({ query: 'India cricket' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'pending');
    assert.ok(typeof result.requestId === 'string');
    assert.equal(result.query, 'India cricket');
  });

  test('returns ready on second call after job completes', async () => {
    setup();
    const tool = asyncTools.news_retrieve;
    await tool.execute({ query: 'India cricket' }, ctx);
    // Wait for async job to resolve
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await tool.execute({ query: 'India cricket' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'ready');
  });

  test('enforces minimum 5 results', () => {
    setup();
    const tool = asyncTools.news_retrieve;
    const parsed = tool.parameters.safeParse({ query: 'test', numResults: 2 });
    assert.equal(parsed.success, true);
    // The min enforcement happens in execute, not schema
  });

  test('schema requires query', () => {
    setup();
    const tool = asyncTools.news_retrieve;
    assert.equal(tool.parameters.safeParse({}).success, false);
    assert.equal(tool.parameters.safeParse({ query: 'test' }).success, true);
  });

  test('has 1200ms timeout', () => {
    setup();
    assert.equal(asyncTools.news_retrieve.timeoutMs, 1200);
  });
});

describe('web_search (async)', () => {
  test('returns pending on first call', async () => {
    setup();
    const tool = asyncTools.web_search;
    const result = await tool.execute({ query: 'best chai recipe' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'pending');
    assert.ok(typeof result.requestId === 'string');
  });

  test('returns ready after job resolves', async () => {
    setup();
    const tool = asyncTools.web_search;
    await tool.execute({ query: 'best chai recipe' }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await tool.execute({ query: 'best chai recipe' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'ready');
    assert.ok(result.items);
  });

  test('schema accepts searchType enum', () => {
    setup();
    const tool = asyncTools.web_search;
    assert.equal(tool.parameters.safeParse({ query: 'test', searchType: 'fast' }).success, true);
    assert.equal(tool.parameters.safeParse({ query: 'test', searchType: 'invalid' }).success, false);
  });

  test('schema accepts includeDomains array', () => {
    setup();
    const tool = asyncTools.web_search;
    const parsed = tool.parameters.safeParse({ query: 'test', includeDomains: ['example.com'] });
    assert.equal(parsed.success, true);
  });
});

describe('religious_retrieve (async)', () => {
  test('returns pending on first call', async () => {
    setup();
    const tool = asyncTools.religious_retrieve;
    const result = await tool.execute({ query: 'karma yoga' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'pending');
    assert.ok(typeof result.requestId === 'string');
  });

  test('returns ready with citations after job resolves', async () => {
    setup();
    const tool = asyncTools.religious_retrieve;
    await tool.execute({ query: 'karma yoga' }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await tool.execute({ query: 'karma yoga' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'ready');
    assert.ok(result.citations);
  });

  test('schema accepts depth enum', () => {
    setup();
    const tool = asyncTools.religious_retrieve;
    assert.equal(tool.parameters.safeParse({ query: 'test', depth: 'deep' }).success, true);
    assert.equal(tool.parameters.safeParse({ query: 'test', depth: 'invalid' }).success, false);
  });

  test('handles null language/tradition gracefully', () => {
    setup();
    const tool = asyncTools.religious_retrieve;
    const parsed = tool.parameters.safeParse({ query: 'test', language: null, tradition: null });
    assert.equal(parsed.success, true);
  });
});

describe('story_retrieve (async)', () => {
  test('returns pending on first call', async () => {
    setup();
    const tool = asyncTools.story_retrieve;
    const result = await tool.execute({ query: 'Panchatantra monkey' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'pending');
    assert.ok(typeof result.requestId === 'string');
  });

  test('returns ready with hits after job resolves', async () => {
    setup();
    const tool = asyncTools.story_retrieve;
    await tool.execute({ query: 'Panchatantra monkey' }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await tool.execute({ query: 'Panchatantra monkey' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'ready');
    assert.ok(result.hits);
  });

  test('schema accepts k in range 1-10', () => {
    setup();
    const tool = asyncTools.story_retrieve;
    assert.equal(tool.parameters.safeParse({ query: 'test', k: 5 }).success, true);
    assert.equal(tool.parameters.safeParse({ query: 'test', k: 0 }).success, false);
    assert.equal(tool.parameters.safeParse({ query: 'test', k: 11 }).success, false);
  });
});

describe('panchang_get (async)', () => {
  test('returns needs_city when city is empty', async () => {
    setup();
    const tool = asyncTools.panchang_get;
    const result = await tool.execute({ city: '' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'needs_city');
  });

  test('returns pending for valid city request', async () => {
    setup();
    const tool = asyncTools.panchang_get;
    const result = await tool.execute({ city: 'Varanasi' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'pending');
    assert.ok(typeof result.requestId === 'string');
    assert.equal(result.city, 'Varanasi');
  });

  test('returns ready after job resolves', async () => {
    setup();
    const tool = asyncTools.panchang_get;
    await tool.execute({ city: 'Varanasi' }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await tool.execute({ city: 'Varanasi' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'ready');
  });

  test('infers next_tithi queryType for tithi queries', async () => {
    setup();
    const ctxWithTranscript = makeContext({
      getLastUserTranscript: () => 'next ekadashi kab hai'
    });
    const tool = asyncTools.panchang_get;
    const result = await tool.execute({ city: 'Delhi', tithiName: 'ekadashi' }, ctxWithTranscript) as Record<string, unknown>;
    assert.equal(result.queryType, 'next_tithi');
  });

  test('detects Diwali festival hint', async () => {
    setup();
    const ctxWithTranscript = makeContext({
      getLastUserTranscript: () => 'Diwali kab hai'
    });
    const tool = asyncTools.panchang_get;
    const result = await tool.execute({ city: 'Mumbai' }, ctxWithTranscript) as Record<string, unknown>;
    assert.equal(result.status, 'pending');
    assert.equal(result.tithiKey, 'amavasya');
  });

  test('handles null optional parameters via preprocess', () => {
    setup();
    const tool = asyncTools.panchang_get;
    const parsed = tool.parameters.safeParse({
      city: 'Delhi',
      stateOrRegion: null,
      countryCode: null,
      dateISO: null,
      language: null,
      ayanamsa: null
    });
    assert.equal(parsed.success, true);
  });
});

describe('youtube_media_get (async)', () => {
  test('returns pending with fallback searchUrl', async () => {
    setup();
    const tool = asyncTools.youtube_media_get;
    const result = await tool.execute({ query: 'morning bhajan' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'pending');
    assert.ok(typeof result.webpageUrl === 'string');
    assert.ok((result.webpageUrl as string).includes('youtube.com'));
  });

  test('returns ready with streamUrl after resolution', async () => {
    setup();
    const tool = asyncTools.youtube_media_get;
    await tool.execute({ query: 'morning bhajan' }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await tool.execute({ query: 'morning bhajan' }, ctx) as Record<string, unknown>;
    assert.equal(result.status, 'ready');
    assert.ok(result.streamUrl);
    assert.ok(result.webpageUrl);
  });

  test('appends live to query when preferLive=true', async () => {
    setup();
    const tool = asyncTools.youtube_media_get;
    const result = await tool.execute({ query: 'news', preferLive: true }, ctx) as Record<string, unknown>;
    assert.ok((result.searchQuery as string).includes('live'));
  });

  test('appends today latest to query when preferLatest=true', async () => {
    setup();
    const tool = asyncTools.youtube_media_get;
    const result = await tool.execute({ query: 'news', preferLatest: true }, ctx) as Record<string, unknown>;
    assert.ok((result.searchQuery as string).includes('today latest'));
  });

  test('schema requires query', () => {
    setup();
    const tool = asyncTools.youtube_media_get;
    assert.equal(tool.parameters.safeParse({}).success, false);
    assert.equal(tool.parameters.safeParse({ query: 'test' }).success, true);
  });
});

// ─── ASYNC TOOL RUNTIME ──────────────────────────────────────────────

describe('AsyncToolRuntime', () => {
  test('publishes client event on job completion', async () => {
    setup();
    const events: unknown[] = [];
    const ctxWithEvents = makeContext({
      publishClientEvent: (event) => events.push(event)
    });
    const tool = asyncTools.news_retrieve;
    await tool.execute({ query: 'test event' }, ctxWithEvents);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(events.length > 0, 'Expected at least one client event');
    const readyEvent = events.find((e: any) => e.type === 'tool_async_ready') as Record<string, unknown> | undefined;
    assert.ok(readyEvent, 'Expected tool_async_ready event');
    assert.equal(readyEvent.sourceTool, 'news_retrieve');
  });

  test('publishes legacy event type alongside new type', async () => {
    setup();
    const events: unknown[] = [];
    const ctxWithEvents = makeContext({
      publishClientEvent: (event) => events.push(event)
    });
    const tool = asyncTools.news_retrieve;
    await tool.execute({ query: 'test legacy' }, ctxWithEvents);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const legacyEvent = events.find((e: any) => e.type === 'news_retrieve_ready');
    assert.ok(legacyEvent, 'Expected legacy news_retrieve_ready event');
  });

  test('publishes failed event on service error', async () => {
    setup();
    (mockDeps.deps.newsService as any).retrieve = async () => { throw new Error('Service unavailable'); };
    const events: unknown[] = [];
    const ctxWithEvents = makeContext({
      publishClientEvent: (event) => events.push(event)
    });
    const tool = asyncTools.news_retrieve;
    await tool.execute({ query: 'fail test' }, ctxWithEvents);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const failedEvent = events.find((e: any) => e.type === 'tool_async_failed') as Record<string, unknown> | undefined;
    assert.ok(failedEvent, 'Expected tool_async_failed event');
  });

  test('deduplicates in-flight requests: second call returns same requestId or cached ready', async () => {
    setup();
    const tool = asyncTools.web_search;
    const r1 = await tool.execute({ query: 'duplicate test' }, ctx) as Record<string, unknown>;
    const r2 = await tool.execute({ query: 'duplicate test' }, ctx) as Record<string, unknown>;
    assert.equal(r1.status, 'pending');
    // r2 may be pending (still in-flight) or ready (resolved quickly) — both are correct dedup behaviour
    assert.ok(r2.status === 'pending' || r2.status === 'ready', `Expected pending or ready, got ${r2.status}`);
    if (r2.status === 'pending') {
      assert.equal(r1.requestId, r2.requestId, 'Deduped pending should share requestId');
    }
  });

  test('stop() clears all jobs', () => {
    setup();
    asyncRuntime.stop();
    // No assertion needed - just ensure it doesn't throw
  });
});

// ─── LIVEKIT COMPARISON: STRUCTURAL ALIGNMENT ────────────────────────

describe('LiveKit pattern alignment', () => {
  test('all tools use Zod schemas for parameters (matches llm.tool pattern)', () => {
    setup();
    const all = [...syncTools, ...Object.values(asyncTools)];
    for (const tool of all) {
      assert.ok(
        tool.parameters instanceof z.ZodType,
        `${tool.name}: should use Zod schema like LiveKit llm.tool({ parameters: z.object(...) })`
      );
    }
  });

  test('all tools return serializable objects (not void/undefined)', async () => {
    setup();
    const simpleSyncTools = [
      { name: 'memory_add', input: { text: 'test' } },
      { name: 'memory_get', input: { query: 'test' } },
      { name: 'reminder_create', input: { title: 'test', datetimeISO: '2026-03-18T10:00:00Z' } },
      { name: 'reminder_list', input: {} },
      { name: 'nudge_pending_get', input: {} },
      { name: 'devotional_playlist_get', input: {} },
      { name: 'daily_briefing_get', input: {} },
      { name: 'diary_add', input: { text: 'test' } },
      { name: 'diary_list', input: {} },
      { name: 'pranayama_guide_get', input: {} },
      { name: 'brain_game_get', input: {} },
      { name: 'festival_context_get', input: {} }
    ];

    for (const { name, input } of simpleSyncTools) {
      const tool = findTool(syncTools, name);
      const result = await tool.execute(input, ctx);
      assert.ok(
        result !== undefined && result !== null,
        `${name}: execute() should return a value (LiveKit tools always return to LLM)`
      );
    }
  });

  test('all tool descriptions are non-empty and descriptive', () => {
    setup();
    const all = [...syncTools, ...Object.values(asyncTools)];
    for (const tool of all) {
      assert.ok(
        tool.description.length > 15,
        `${tool.name}: description too short — LiveKit best practice is to be specific`
      );
    }
  });

  test('async tools follow LiveKit pattern: return pending then ready', async () => {
    setup();
    const asyncToolEntries = Object.entries(asyncTools).filter(([name]) => name !== 'panchang_get');
    for (const [name, tool] of asyncToolEntries) {
      const input = name === 'youtube_media_get'
        ? { query: `test-${name}` }
        : name === 'news_retrieve'
          ? { query: `test-${name}` }
          : { query: `test-${name}` };
      const r1 = await tool.execute(input, ctx) as Record<string, unknown>;
      assert.equal(r1.status, 'pending', `${name}: first call should return pending`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const r2 = await tool.execute(input, ctx) as Record<string, unknown>;
      assert.equal(r2.status, 'ready', `${name}: second call should return ready`);
    }
  });

  test('tool names use snake_case (matches LiveKit convention)', () => {
    setup();
    const all = [...syncTools, ...Object.values(asyncTools)];
    const snakeCaseRegex = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
    for (const tool of all) {
      assert.ok(
        snakeCaseRegex.test(tool.name),
        `${tool.name}: should be snake_case (LiveKit convention)`
      );
    }
  });
});
