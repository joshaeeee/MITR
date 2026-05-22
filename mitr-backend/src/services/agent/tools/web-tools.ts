import { z } from 'zod';
import { AsyncToolRuntime } from '../../../agent-worker/async-tool-runtime.js';
import type {
  AgentToolDefinition,
  AgentToolContext,
  ToolDeps
} from './legacy-tools.js';

export const createWebSearchTool = (
  deps: ToolDeps,
  runtime: AsyncToolRuntime
): AgentToolDefinition => ({
  name: 'web_search',
  description:
    'Search the web for current factual context, websites, comparisons, official pages, recommendations, or research links. Use news_retrieve instead for news briefings, headlines, latest/current events, or taaza khabar. Include domains only when the user asks for a specific site/source or official sources are required. If results are pending, acknowledge briefly and wait; when ready, answer from returned source links/summaries and do not invent missing details.',
  parameters: z.object({
    query: z.string(),
    numResults: z.number().int().min(1).max(8).nullish(),
    recencyDays: z.number().int().min(1).max(365).nullish(),
    language: z.string().nullish(),
    regionCode: z.string().nullish(),
    includeDomains: z.array(z.string()).max(8).optional(),
    searchType: z.enum(['auto', 'fast', 'instant', 'neural', 'deep']).nullish()
  }),
  timeoutMs: 1200,
  execute: async (input, context: AgentToolContext) => {
    const normalizedInput = {
      query: input.query.trim(),
      numResults: input.numResults ?? undefined,
      recencyDays: input.recencyDays ?? undefined,
      language: input.language ?? context.language,
      regionCode: input.regionCode ?? undefined,
      includeDomains: input.includeDomains ?? undefined,
      searchType: input.searchType ?? undefined
    };

    const key = `${context.sessionId}:${JSON.stringify(normalizedInput)}`;

    return runtime.start({
      tool: 'web_search',
      key,
      requestIdPrefix: 'web',
      context,
      ttlMs: 2 * 60 * 1000,
      legacyReadyType: 'web_search_ready',
      legacyFailedType: 'web_search_failed',
      pendingResponse: (requestId) => ({
        status: 'pending',
        requestId,
        query: normalizedInput.query,
        message: 'Searching the web in background.'
      }),
      execute: async () =>
        deps.webSearchService.search(normalizedInput.query, {
          numResults: normalizedInput.numResults,
          recencyDays: normalizedInput.recencyDays,
          language: normalizedInput.language,
          regionCode: normalizedInput.regionCode,
          includeDomains: normalizedInput.includeDomains,
          searchType: normalizedInput.searchType
        }),
      onReady: (requestId, items) => ({
        response: {
          status: 'ready',
          requestId,
          query: normalizedInput.query,
          items
        },
        payload: {
          query: normalizedInput.query,
          itemCount: items.length,
          recencyDays: normalizedInput.recencyDays,
          includeDomains: normalizedInput.includeDomains,
          items
        }
      }),
      onFailed: (_requestId, error) => ({
        payload: {
          query: normalizedInput.query,
          error
        }
      })
    });
  }
});
