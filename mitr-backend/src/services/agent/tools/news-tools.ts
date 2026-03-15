import { z } from 'zod';
import { AsyncToolRuntime } from '../../../agent-worker/async-tool-runtime.js';
import type {
  AgentToolDefinition,
  AgentToolContext,
  ToolDeps
} from './legacy-tools.js';

const MIN_NEWS_RESULTS = 5;

const isLikelyNewsListing = (item: { title: string; url: string }): boolean => {
  const title = item.title.toLowerCase();
  const url = item.url.toLowerCase();
  const titleSignals = ['latest news', 'top news', 'headlines', 'news in', 'live updates'];
  const urlSignals = ['/latest-news', '/headlines', '/news/', '/top-news', '/live-updates'];
  return titleSignals.some((s) => title.includes(s)) || urlSignals.some((s) => url.includes(s));
};

const assessNewsQuality = (
  items: Array<{ title: string; url: string; publishedAt: string }>
): {
  listingOnly: boolean;
  hasPublishedDates: boolean;
  confidence: 'low' | 'medium' | 'high';
} => {
  if (items.length === 0) {
    return { listingOnly: true, hasPublishedDates: false, confidence: 'low' };
  }
  const nonListingCount = items.filter((item) => !isLikelyNewsListing(item)).length;
  const hasPublishedDates = items.some(
    (item) => Boolean(item.publishedAt) && !Number.isNaN(Date.parse(item.publishedAt))
  );
  const listingOnly = nonListingCount === 0;
  const confidence: 'low' | 'medium' | 'high' =
    listingOnly || !hasPublishedDates ? 'low' : nonListingCount >= 2 ? 'high' : 'medium';
  return { listingOnly, hasPublishedDates, confidence };
};

export const createNewsRetrieveTool = (
  deps: ToolDeps,
  runtime: AsyncToolRuntime
): AgentToolDefinition => ({
  name: 'news_retrieve',
  description:
    'Retrieve current-affairs news for the requested query/region. Returns ready or pending.',
  parameters: z.object({
    query: z.string(),
    freshness: z.enum(['latest', 'recent', 'general']).nullish(),
    language: z.string().nullish(),
    regionCode: z.string().nullish(),
    stateOrCity: z.string().nullish(),
    numResults: z.number().int().min(1).max(15).nullish(),
    recencyDays: z.number().int().min(1).max(30).nullish()
  }),
  timeoutMs: 1200,
  execute: async (input, context: AgentToolContext) => {
    const normalizedInput = {
      query: input.query.trim(),
      freshness: input.freshness ?? undefined,
      language: input.language ?? undefined,
      regionCode: input.regionCode ?? undefined,
      stateOrCity: input.stateOrCity ?? undefined,
      numResults: Math.max(input.numResults ?? MIN_NEWS_RESULTS, MIN_NEWS_RESULTS),
      recencyDays: input.recencyDays ?? undefined
    };
    const key = `${context.sessionId}:${JSON.stringify(normalizedInput)}`;

    return runtime.start({
      tool: 'news_retrieve',
      key,
      requestIdPrefix: 'news',
      context,
      ttlMs: 2 * 60 * 1000,
      legacyReadyType: 'news_retrieve_ready',
      legacyFailedType: 'news_retrieve_failed',
      pendingResponse: (requestId) => ({
        status: 'pending',
        requestId,
        query: normalizedInput.query,
        stateOrCity: normalizedInput.stateOrCity,
        regionCode: normalizedInput.regionCode,
        freshness: normalizedInput.freshness,
        message: 'Fetching latest regional news in background.'
      }),
      execute: async () =>
        deps.newsService.retrieve(normalizedInput.query, {
          language: normalizedInput.language,
          regionCode: normalizedInput.regionCode,
          stateOrCity: normalizedInput.stateOrCity,
          numResults: normalizedInput.numResults,
          recencyDays: normalizedInput.recencyDays,
          freshness: normalizedInput.freshness
        }),
      onReady: (requestId, items) => {
        const summaries = items
          .map((item) => item.summary?.trim())
          .filter((summary): summary is string => Boolean(summary));
        const quality = assessNewsQuality(items);
        const payload = {
          query: normalizedInput.query,
          stateOrCity: normalizedInput.stateOrCity,
          regionCode: normalizedInput.regionCode,
          freshness: normalizedInput.freshness,
          itemCount: items.length,
          quality,
          summaries
        };
        return {
          response: {
            status: 'ready',
            requestId,
            summaries,
            quality
          },
          payload
        };
      },
      onFailed: (_requestId, error) => ({
        payload: {
          query: normalizedInput.query,
          stateOrCity: normalizedInput.stateOrCity,
          regionCode: normalizedInput.regionCode,
          freshness: normalizedInput.freshness,
          error
        }
      })
    });
  }
});
