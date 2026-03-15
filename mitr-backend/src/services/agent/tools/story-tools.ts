import { z } from 'zod';
import { AsyncToolRuntime } from '../../../agent-worker/async-tool-runtime.js';
import type { AgentToolDefinition, AgentToolContext, ToolDeps } from './legacy-tools.js';

const optionalStringArg = () =>
  z.preprocess((value) => (value == null ? undefined : value), z.string().optional());

export const createStoryRetrieveTool = (
  deps: ToolDeps,
  runtime: AsyncToolRuntime
): AgentToolDefinition => ({
  name: 'story_retrieve',
  description:
    'Use for story requests. Retrieves grounded Indian story passages (Panchatantra/Ramayana/Mahabharata/Akbar-Birbal/Jataka/folk). Returns ready|pending; if pending, acknowledge briefly and continue naturally.',
  parameters: z.object({
    query: z.string(),
    language: optionalStringArg(),
    tradition: optionalStringArg(),
    region: optionalStringArg(),
    k: z.number().int().min(1).max(10).optional()
  }),
  timeoutMs: 1200,
  execute: async (input, context: AgentToolContext) => {
    const normalizedInput = {
      query: input.query.trim(),
      language: input.language ?? undefined,
      tradition: input.tradition ?? undefined,
      region: input.region ?? undefined,
      k: input.k ?? undefined
    };
    const key = `${context.sessionId}:${JSON.stringify(normalizedInput)}`;

    return runtime.start({
      tool: 'story_retrieve',
      key,
      requestIdPrefix: 'story',
      context,
      ttlMs: 2 * 60 * 1000,
      legacyReadyType: 'story_retrieve_ready',
      legacyFailedType: 'story_retrieve_failed',
      pendingResponse: (requestId) => ({
        status: 'pending',
        requestId,
        query: normalizedInput.query,
        message: 'Retrieving story passages in background.'
      }),
      execute: async () => deps.religiousRetriever.retrieveStories(normalizedInput),
      onReady: (requestId, hits) => ({
        response: {
          status: 'ready',
          requestId,
          hits
        },
        payload: {
          query: normalizedInput.query,
          language: normalizedInput.language,
          tradition: normalizedInput.tradition,
          region: normalizedInput.region,
          k: normalizedInput.k,
          hitCount: hits.length,
          hits
        }
      }),
      onFailed: (_requestId, error) => ({
        payload: {
          query: normalizedInput.query,
          language: normalizedInput.language,
          tradition: normalizedInput.tradition,
          region: normalizedInput.region,
          k: normalizedInput.k,
          error
        }
      })
    });
  }
});
