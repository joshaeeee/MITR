import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

interface ExaResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  text?: string;
  highlights?: string[];
  summary?: string;
}

interface ExaSearchResponse {
  results?: ExaResult[];
}

export interface WebSearchItem {
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface WebSearchOptions {
  numResults?: number;
  recencyDays?: number;
  language?: string;
  regionCode?: string;
  includeDomains?: string[];
  searchType?: 'auto' | 'fast' | 'instant' | 'neural' | 'deep';
}

const compactWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const clip = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
};

const sourceFromUrl = (rawUrl?: string): string => {
  if (!rawUrl) return 'Unknown';
  try {
    const host = new URL(rawUrl).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return 'Unknown';
  }
};

const summarize = (result: ExaResult): string => {
  if (typeof result.summary === 'string' && result.summary.length > 0) {
    return clip(compactWhitespace(result.summary), 1000);
  }
  if (Array.isArray(result.highlights) && result.highlights.length > 0) {
    return clip(compactWhitespace(result.highlights.join(' ')), 900);
  }
  if (typeof result.text === 'string' && result.text.length > 0) {
    return clip(compactWhitespace(result.text), 900);
  }
  return 'No summary available.';
};

const isoDateDaysAgo = (days: number): string => {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
};

export class WebSearchService {
  private cache = new Map<string, { items: WebSearchItem[]; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 2 * 60 * 1000;

  async search(query: string, options: WebSearchOptions = {}): Promise<WebSearchItem[]> {
    if (!env.EXA_API_KEY) {
      logger.warn('EXA_API_KEY is not configured; web search disabled');
      return [];
    }

    const cleanedQuery = query.trim();
    if (!cleanedQuery) return [];

    const regionCode = (options.regionCode ?? env.EXA_DEFAULT_REGION ?? 'IN').toUpperCase();
    const numResults = Math.min(Math.max(options.numResults ?? 5, 1), 8);
    const recencyDays = Math.min(Math.max(options.recencyDays ?? 30, 1), 365);
    const includeDomains = (options.includeDomains ?? [])
      .map((d) => d.trim())
      .filter(Boolean);
    const searchType = options.searchType ?? 'auto';
    const textMaxChars = Math.min(Math.max(env.EXA_NEWS_TEXT_MAX_CHARS, 700), 3000);
    const summaryQuery =
      env.EXA_NEWS_SUMMARY_STYLE === 'detailed'
        ? 'Give a factual summary with key entities, dates, and concrete details.'
        : 'Give a concise factual summary.';

    const effectiveQuery = [
      cleanedQuery,
      options.language?.toLowerCase().startsWith('hi') ? 'Hindi context' : '',
      regionCode ? `${regionCode} region` : ''
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    const cacheKey = JSON.stringify({
      query: effectiveQuery,
      numResults,
      recencyDays,
      searchType,
      includeDomains
    });
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      logger.info('Exa web search cache hit', { query: effectiveQuery });
      return cached.items;
    }

    const requestBody: Record<string, unknown> = {
      query: effectiveQuery,
      type: searchType,
      numResults,
      startPublishedDate: isoDateDaysAgo(recencyDays),
      endPublishedDate: new Date().toISOString(),
      contents: {
        text: {
          maxCharacters: textMaxChars
        },
        summary: {
          query: summaryQuery
        }
      },
      moderation: true
    };

    if (includeDomains.length > 0) {
      requestBody.includeDomains = includeDomains;
    }

    const response = await fetch(`${env.EXA_BASE_URL}/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.EXA_API_KEY
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error('Exa web search failed', {
        status: response.status,
        body,
        query: effectiveQuery
      });
      return [];
    }

    const payload = (await response.json()) as ExaSearchResponse;
    const items = (payload.results ?? [])
      .filter((item) => Boolean(item.url) && Boolean(item.title))
      .map((item) => ({
        title: String(item.title),
        summary: summarize(item),
        source: sourceFromUrl(item.url),
        url: String(item.url),
        publishedAt: item.publishedDate ? String(item.publishedDate) : ''
      }))
      .slice(0, numResults);

    logger.info('Exa web search success', {
      query: effectiveQuery,
      numResults: items.length,
      recencyDays,
      includeDomains: includeDomains.length
    });

    this.cache.set(cacheKey, {
      items,
      expiresAt: Date.now() + WebSearchService.CACHE_TTL_MS
    });

    return items;
  }
}
