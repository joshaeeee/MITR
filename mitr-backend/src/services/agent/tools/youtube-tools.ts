import { z } from 'zod';
import { AsyncToolRuntime } from '../../../agent-worker/async-tool-runtime.js';
import { env } from '../../../config/env.js';
import type { AgentToolDefinition, AgentToolContext, ToolDeps } from './legacy-tools.js';

const optionalStringArg = () =>
  z.preprocess((value) => (value == null ? undefined : value), z.string().optional());

const youtubeSearchUrl = (query: string): string =>
  `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

export const createYoutubeMediaTool = (
  deps: ToolDeps,
  runtime: AsyncToolRuntime
): AgentToolDefinition => ({
  name: 'youtube_media_get',
  description:
    'Resolve YouTube media for playback by query. Use for requests like play news/music/bhajan/live video. If result is pending, acknowledge briefly and stop. Do not ask a new question.',
  parameters: z.object({
    query: z.string(),
    preferLive: z.boolean().optional(),
    preferLatest: z.boolean().optional(),
    regionHint: optionalStringArg(),
    language: optionalStringArg()
  }),
  timeoutMs: env.YOUTUBE_MEDIA_TIMEOUT_MS,
  execute: async (input, context: AgentToolContext) => {
    const searchQuery = [
      input.query.trim(),
      input.preferLive ? 'live' : '',
      input.preferLatest ? 'today latest' : ''
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    const fallbackWebpageUrl = youtubeSearchUrl(searchQuery);

    return runtime.start({
      tool: 'youtube_media_get',
      key: `${context.sessionId}:${searchQuery}`,
      requestIdPrefix: 'yt',
      context,
      ttlMs: 2 * 60 * 1000,
      legacyReadyType: 'youtube_media_ready',
      legacyFailedType: 'youtube_media_failed',
      pendingResponse: (requestId) => ({
        status: 'pending',
        requestId,
        title: input.query.trim(),
        searchQuery,
        webpageUrl: fallbackWebpageUrl,
        message:
          'Resolving media in background. Acknowledge briefly, ask no new question, and wait for playback readiness.'
      }),
      execute: async () => deps.youtubeStreamService.resolveFromSearch(searchQuery),
      onReady: (requestId, resolved) => ({
        response: {
          status: 'ready',
          requestId,
          title: resolved.title,
          searchQuery: resolved.searchQuery,
          streamUrl: resolved.streamUrl,
          webpageUrl: resolved.webpageUrl
        },
        payload: {
          title: resolved.title,
          searchQuery: resolved.searchQuery,
          streamUrl: resolved.streamUrl,
          webpageUrl: resolved.webpageUrl
        }
      }),
      onFailed: (_requestId, error) => ({
        payload: {
          searchQuery,
          error
        }
      })
    });
  }
});
