import { env } from '../../config/env.js';

export interface NewsItem {
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
}

export interface NewsRetrieveOptions {
  language?: string;
  regionCode?: string;
  stateOrCity?: string;
  numResults?: number;
  recencyDays?: number;
  freshness?: 'latest' | 'recent' | 'general';
}

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

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const compactWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const isoDateDaysAgo = (days: number): string => {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
};

const sourceFromUrl = (rawUrl?: string): string => {
  if (!rawUrl) return 'Unknown';
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return 'Unknown';
  }
};

const toSummary = (result: ExaResult): string => {
  const fromSummary = typeof result.summary === 'string' ? compactWhitespace(result.summary) : '';
  if (fromSummary) return fromSummary;

  const fromText = typeof result.text === 'string' ? compactWhitespace(result.text) : '';
  if (fromText) return fromText;

  const fromHighlights = Array.isArray(result.highlights)
    ? compactWhitespace(
        result.highlights
          .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
          .join(' ')
      )
    : '';
  if (fromHighlights) return fromHighlights;

  return 'No summary available.';
};

const SUMMARY_PROMPT = [
  'Rewrite this news summary for voice playback. Keep it factual, crisp, and easy to speak.',
  'Rules:',
  '- Max 150 words.',
  '- Min 75 words.',
  '- Cover only one main story.',
  '- Include: what happened, where/when, why it matters.',
  '- Remove website boilerplate, ads, navigation text, and unrelated items.',
  '- No speculation, no extra background unless essential.',
  '- Output plain conversational text only.', 
  '- Summary has to be in hindi language.'
].join('\n');

export class NewsService {
  private cache = new Map<string, { items: NewsItem[]; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 2 * 60 * 1000;

  private async runSearch(requestBody: Record<string, unknown>): Promise<ExaSearchResponse | null> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': env.EXA_API_KEY as string
    };

    const call = async (): Promise<Response> =>
      fetch(`${env.EXA_BASE_URL}/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

    let response = await call();
    if (!response.ok) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      response = await call();
      if (!response.ok) return null;
    }

    return (await response.json()) as ExaSearchResponse;
  }

  async retrieve(query: string, options: NewsRetrieveOptions = {}): Promise<NewsItem[]> {
    if (!env.EXA_API_KEY) return [];

    const normalizedQuery = compactWhitespace(query);
    if (!normalizedQuery) return [];

    const numResults = clamp(options.numResults ?? 10, 1, 20);
    const recencyDays = clamp(options.recencyDays ?? env.EXA_DEFAULT_RECENCY_DAYS ?? 3, 1, 30);
    const startPublishedDate = isoDateDaysAgo(recencyDays);
    const endPublishedDate = new Date().toISOString();

    const cacheKey = JSON.stringify({
      query: normalizedQuery,
      recencyDays,
      numResults
    });

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.items;
    }

    const requestBody: Record<string, unknown> = {
      query: `Give the latest news on ${normalizedQuery}`,
      category: 'news',
      type: 'deep',
      numResults,
      outputSchema: {
        type: 'object'
      },
      startPublishedDate,
      endPublishedDate,
      contents: {
        highlights: {
          maxCharacters: 4000
        },
        summary: {
          query: SUMMARY_PROMPT
        },
        extras: {
          links: 1
        }
      }
    };

    const payload = await this.runSearch(requestBody);
    if (!payload) return [];

    const items = (payload.results ?? [])
      .filter((item) => Boolean(item.url) && Boolean(item.title))
      .map((item) => ({
        title: String(item.title).trim(),
        summary: toSummary(item),
        source: sourceFromUrl(item.url),
        url: String(item.url),
        publishedAt: item.publishedDate ? String(item.publishedDate) : ''
      }))
      .slice(0, numResults);

    this.cache.set(cacheKey, {
      items,
      expiresAt: Date.now() + NewsService.CACHE_TTL_MS
    });

    return items;
  }
}
