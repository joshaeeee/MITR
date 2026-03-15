import { z } from 'zod';
import { AsyncToolRuntime } from '../../../agent-worker/async-tool-runtime.js';
import type { AgentToolDefinition, AgentToolContext, ToolDeps } from './legacy-tools.js';

const optionalStringArg = () =>
  z.preprocess((value) => (value == null ? undefined : value), z.string().optional());

export const createReligiousRetrieveTool = (
  deps: ToolDeps,
  runtime: AsyncToolRuntime
): AgentToolDefinition => ({
  name: 'religious_retrieve',
  description:
    'Use for scripture/religious questions requiring grounded citations. Returns status=ready|pending with citations when ready. If pending, acknowledge briefly and continue without fabricating quotes.',
  parameters: z.object({
    query: z.string(),
    language: optionalStringArg(),
    tradition: optionalStringArg(),
    depth: z.enum(['short', 'standard', 'deep']).optional()
  }),
  timeoutMs: 1200,
  execute: async (input, context: AgentToolContext) => {
    const normalizedInput = {
      query: input.query.trim(),
      language: input.language ?? undefined,
      tradition: input.tradition ?? undefined,
      depth: input.depth ?? undefined
    };
    const key = `${context.sessionId}:${JSON.stringify(normalizedInput)}`;

    return runtime.start({
      tool: 'religious_retrieve',
      key,
      requestIdPrefix: 'rr',
      context,
      ttlMs: 2 * 60 * 1000,
      legacyReadyType: 'religious_retrieve_ready',
      legacyFailedType: 'religious_retrieve_failed',
      pendingResponse: (requestId) => ({
        status: 'pending',
        requestId,
        query: normalizedInput.query,
        message: 'Retrieving grounded citations in background.'
      }),
      execute: async () => deps.religiousRetriever.retrieve(normalizedInput),
      onReady: (requestId, citations) => ({
        response: {
          status: 'ready',
          requestId,
          citations
        },
        payload: {
          query: normalizedInput.query,
          language: normalizedInput.language,
          tradition: normalizedInput.tradition,
          depth: normalizedInput.depth,
          citationCount: citations.length,
          citations
        }
      }),
      onFailed: (_requestId, error) => ({
        payload: {
          query: normalizedInput.query,
          language: normalizedInput.language,
          tradition: normalizedInput.tradition,
          depth: normalizedInput.depth,
          error
        }
      })
    });
  }
});
