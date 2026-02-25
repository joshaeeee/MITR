import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

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

interface NewsRssItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
}

const LATEST_QUERY_HINTS = [
  'latest',
  'recent',
  'today',
  'current',
  'breaking',
  'abhi',
  'aaj',
  'taaza',
  'taaza khabar',
  'naya',
  'nai',
  'abtak'
];

const GENERIC_NEWS_HINTS = [
  'news',
  'latest news',
  'current news',
  'today news',
  'breaking news',
  'khabar',
  'khabrein',
  'samachar',
  'खबर',
  'खबरें',
  'समाचार'
];

const isoDateDaysAgo = (days: number): string => {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
};

const isLatestIntent = (query: string): boolean => {
  const normalized = query.toLowerCase();
  return LATEST_QUERY_HINTS.some((hint) => normalized.includes(hint));
};

const resolveFreshness = (query: string, options: NewsRetrieveOptions): 'latest' | 'recent' | 'general' => {
  if (options.freshness) return options.freshness;
  if (isLatestIntent(query)) return 'latest';
  return 'general';
};

const isGenericNewsQuery = (query: string): boolean => {
  const normalized = compactWhitespace(query.toLowerCase());
  return GENERIC_NEWS_HINTS.some((hint) => normalized === hint || normalized.includes(hint));
};

const normalizeToken = (value?: string): string =>
  compactWhitespace((value ?? '').toLowerCase())
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();

const localityTokens = (stateOrCity?: string): string[] => {
  const normalized = normalizeToken(stateOrCity);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter((token) => token.length >= 3);
};

const compactWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const clip = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
};

const summarize = (result: ExaResult): string => {
  if (typeof result.summary === 'string' && result.summary.length > 0) {
    return clip(compactWhitespace(result.summary), 1100);
  }

  if (Array.isArray(result.highlights) && result.highlights.length > 0) {
    return clip(compactWhitespace(result.highlights.join(' ')), 1000);
  }

  if (typeof result.text === 'string' && result.text.length > 0) {
    return clip(compactWhitespace(result.text), 1000);
  }

  return 'No summary available.';
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

const decodeHtmlEntities = (input: string): string =>
  input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripHtml = (input: string): string => decodeHtmlEntities(input.replace(/<[^>]+>/g, ' '));

const isLikelyListingPage = (item: { title: string; url: string }): boolean => {
  const t = item.title.toLowerCase();
  const u = item.url.toLowerCase();
  const titleSignals = [
    'latest news',
    'today',
    'breaking news',
    'top stories',
    'headlines',
    'news in hindi',
    'न्यूज'
  ];
  const urlSignals = ['/latest-news', '/india-news', '/live-updates', '/top-news', '/headlines'];

  let sectionPath = false;
  try {
    const path = new URL(item.url).pathname.toLowerCase();
    sectionPath =
      /^\/news\/[^/]*\/?$/.test(path) ||
      /^\/(news|latest-news|india-news|live-updates|headlines|top-news)\/?$/.test(path) ||
      /^\/[^/]*news[^/]*\/?$/.test(path);
  } catch {
    sectionPath = false;
  }

  const titleLooksGeneric = titleSignals.some((s) => t.includes(s));
  const urlLooksGeneric = urlSignals.some((s) => u.includes(s)) || sectionPath;
  return titleLooksGeneric || urlLooksGeneric;
};

const allListings = (items: NewsItem[]): boolean => items.length > 0 && items.every((item) => isLikelyListingPage(item));

const hasPublishedDates = (items: NewsItem[]): boolean =>
  items.some((item) => Boolean(item.publishedAt) && !Number.isNaN(Date.parse(item.publishedAt)));

const parseRssTag = (block: string, tag: string): string => {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
};

const parseGoogleNewsRss = (xml: string): NewsRssItem[] => {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  return blocks.map((block) => ({
    title: decodeHtmlEntities(parseRssTag(block, 'title')),
    link: decodeHtmlEntities(parseRssTag(block, 'link')),
    pubDate: decodeHtmlEntities(parseRssTag(block, 'pubDate')),
    description: stripHtml(parseRssTag(block, 'description'))
  }));
};

export class NewsService {
  private cache = new Map<string, { items: NewsItem[]; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 2 * 60 * 1000;

  private async retrieveFromGoogleNewsRss(
    query: string,
    options: NewsRetrieveOptions,
    numResults: number
  ): Promise<NewsItem[]> {
    const regionCode = (options.regionCode ?? env.EXA_DEFAULT_REGION ?? 'IN').toUpperCase();
    const hl = options.language?.toLowerCase().startsWith('hi') ? 'hi-IN' : 'en-IN';
    const ceid = hl.startsWith('hi') ? 'IN:hi' : 'IN:en';
    const url = new URL('https://news.google.com/rss/search');
    url.searchParams.set('q', query);
    url.searchParams.set('hl', hl);
    url.searchParams.set('gl', regionCode);
    url.searchParams.set('ceid', ceid);

    const response = await fetch(url.toString());
    if (!response.ok) {
      logger.warn('Google News RSS fallback failed', { status: response.status, query });
      return [];
    }
    const xml = await response.text();
    const parsed = parseGoogleNewsRss(xml).slice(0, Math.max(numResults * 2, 6));
    const freshness = options.freshness ?? 'general';
    const recencyDays = Math.min(Math.max(options.recencyDays ?? env.EXA_DEFAULT_RECENCY_DAYS ?? 3, 1), 30);
    const cutoffMs =
      freshness === 'latest'
        ? Date.now() - 36 * 60 * 60 * 1000
        : freshness === 'recent'
          ? Date.now() - recencyDays * 24 * 60 * 60 * 1000
          : Date.now() - 30 * 24 * 60 * 60 * 1000;

    const items = parsed
      .filter((item) => Boolean(item.link) && Boolean(item.title))
      .filter((item) => {
        const ts = Date.parse(item.pubDate || '');
        if (Number.isNaN(ts)) return freshness !== 'latest';
        return ts >= cutoffMs;
      })
      .map((item) => ({
        title: item.title,
        summary: clip(compactWhitespace(item.description), 900),
        source:
          item.title.includes(' - ') ? item.title.split(' - ').slice(-1)[0].trim() : sourceFromUrl(item.link),
        url: item.link,
        publishedAt: item.pubDate || ''
      }))
      .filter((item) => !isLikelyListingPage(item))
      .slice(0, numResults);

    logger.info('Google News RSS fallback success', {
      query,
      regionCode,
      language: options.language ?? null,
      freshness,
      results: items.length,
      newestPublishedAt: items[0]?.publishedAt ?? null
    });
    return items;
  }

  async retrieve(query: string, options: NewsRetrieveOptions = {}): Promise<NewsItem[]> {
    if (!env.EXA_API_KEY) {
      logger.warn('EXA_API_KEY is not configured; news retrieval disabled');
      return [];
    }

    const regionCode = (options.regionCode ?? env.EXA_DEFAULT_REGION ?? 'IN').toUpperCase();
    const numResults = Math.min(Math.max(options.numResults ?? env.EXA_DEFAULT_NUM_RESULTS ?? 6, 1), 15);
    const recencyDays = Math.min(Math.max(options.recencyDays ?? env.EXA_DEFAULT_RECENCY_DAYS ?? 3, 1), 30);
    const freshness = resolveFreshness(query, options);
    const latestIntent = freshness === 'latest';

    const includeDomains = (env.EXA_INCLUDE_DOMAINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const baseQuery = isGenericNewsQuery(query)
      ? options.stateOrCity
        ? `${options.stateOrCity} news`
        : `${regionCode} news`
      : query;
    const queryIntentHint =
      freshness === 'latest'
        ? 'latest developments updates'
        : freshness === 'recent'
          ? 'recent developments updates'
          : 'news updates';
    const effectiveQuery = [baseQuery, options.stateOrCity, regionCode === 'IN' ? 'India' : undefined, queryIntentHint]
      .filter(Boolean)
      .join(' ');
    const localTokens = localityTokens(options.stateOrCity);
    const cacheKey = JSON.stringify({
      query: effectiveQuery,
      regionCode,
      freshness: options.freshness ?? '',
      recencyDays,
      numResults
    });
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      logger.info('Exa cache hit', { query: effectiveQuery });
      return cached.items;
    }

    const primaryMaxAgeHours = freshness === 'latest' ? 1 : freshness === 'recent' ? 6 : 12;
    const fallbackMaxAgeHours = freshness === 'latest' ? 6 : freshness === 'recent' ? 24 : 48;
    const textMaxChars = Math.min(Math.max(env.EXA_NEWS_TEXT_MAX_CHARS, 800), 4000);
    const highlightSentences = Math.min(Math.max(env.EXA_NEWS_HIGHLIGHT_SENTENCES, 1), 8);
    const highlightsPerUrl = Math.min(Math.max(env.EXA_NEWS_HIGHLIGHTS_PER_URL, 1), 6);
    const summaryQuery =
      env.EXA_NEWS_SUMMARY_STYLE === 'detailed'
        ? `Give a detailed factual summary with key developments, names, numbers, and immediate relevance for ${options.stateOrCity ?? regionCode}.`
        : 'Give a concise factual summary.';
    const searchType =
      env.EXA_NEWS_SEARCH_TYPE === 'auto' ? 'auto' : env.EXA_NEWS_SEARCH_TYPE;

    const buildBody = (maxAgeHours: number, startPublishedDate: string): Record<string, unknown> => ({
      query: effectiveQuery,
      category: 'news',
      type: searchType,
      numResults,
      userLocation: regionCode,
      startPublishedDate,
      endPublishedDate: new Date().toISOString(),
      maxAgeHours,
      contents: {
        text: {
          maxCharacters: textMaxChars
        },
        highlights: {
          numSentences: highlightSentences,
          highlightsPerUrl,
          query: query
        },
        summary: {
          query: summaryQuery
        }
      },
      moderation: true
    });

    const runSearch = async (body: Record<string, unknown>, queryOverride?: string): Promise<NewsItem[]> => {
      const requestBody = {
        ...body,
        query: queryOverride ?? (body.query as string)
      } as Record<string, unknown>;
      if (includeDomains.length > 0) {
        requestBody.includeDomains = includeDomains;
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-api-key': env.EXA_API_KEY as string
      };

      const response = await fetch(`${env.EXA_BASE_URL}/search`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error('Exa search failed', { status: response.status, body: text });
        return [];
      }

      const payload = (await response.json()) as ExaSearchResponse;
      const results = payload.results ?? [];

      const items = results
        .filter((item) => Boolean(item.url) && Boolean(item.title))
        .map((item) => {
          const title = String(item.title);
          const url = String(item.url);
          const summary = summarize(item);
          const localBlob = normalizeToken(`${title} ${url} ${item.text ?? ''} ${summary}`);
          const localMatch =
            localTokens.length === 0 || localTokens.every((token) => localBlob.includes(token));
          return {
            title,
            summary,
            source: sourceFromUrl(item.url),
            url,
            publishedAt: item.publishedDate ? String(item.publishedDate) : '',
            _localMatch: localMatch
          };
        })
        .filter((item) => item._localMatch || localTokens.length === 0)
        .sort((a, b) => {
          const aLocal = a._localMatch ? 1 : 0;
          const bLocal = b._localMatch ? 1 : 0;
          if (aLocal !== bLocal) return bLocal - aLocal;

          const aListing = isLikelyListingPage(a) ? 1 : 0;
          const bListing = isLikelyListingPage(b) ? 1 : 0;
          if (aListing !== bListing) return aListing - bListing;

          const aTs = Date.parse(a.publishedAt);
          const bTs = Date.parse(b.publishedAt);
          if (Number.isNaN(aTs) && Number.isNaN(bTs)) return 0;
          if (Number.isNaN(aTs)) return 1;
          if (Number.isNaN(bTs)) return -1;
          return bTs - aTs;
        });
      const withoutListings = items.filter((item) => !isLikelyListingPage(item));
      const chosen = withoutListings.length >= 1 ? withoutListings : items;
      const finalItems = chosen.slice(0, numResults).map(({ _localMatch: _drop, ...item }) => item);

      logger.info('Exa search success', {
        query: requestBody.query,
        freshness,
        requestedMaxAgeHours: typeof requestBody.maxAgeHours === 'number' ? requestBody.maxAgeHours : null,
        results: finalItems.length,
        filteredListings: items.length - withoutListings.length,
        newestPublishedAt: finalItems[0]?.publishedAt ?? null
      });

      return finalItems;
    };

    const narrowStart = latestIntent ? isoDateDaysAgo(Math.min(recencyDays, 2)) : isoDateDaysAgo(recencyDays);
    const wideStart = isoDateDaysAgo(recencyDays);
    try {
      const primaryMinResults = latestIntent ? 1 : Math.min(3, numResults);
      const primaryBody = buildBody(primaryMaxAgeHours, narrowStart);
      const primary = await runSearch(primaryBody);
      if (
        primary.length >= primaryMinResults &&
        !(latestIntent && (allListings(primary) || !hasPublishedDates(primary)))
      ) {
        this.cache.set(cacheKey, { items: primary, expiresAt: Date.now() + NewsService.CACHE_TTL_MS });
        return primary;
      }

      logger.warn('Exa primary freshness search returned limited results; widening freshness window', {
        query,
        primaryCount: primary.length,
        primaryMinResults,
        freshness,
        primaryMaxAgeHours,
        fallbackMaxAgeHours
      });

      const fallbackBody = buildBody(fallbackMaxAgeHours, wideStart);
      const fallback = await runSearch(fallbackBody);
      if (
        fallback.length > 0 &&
        !(latestIntent && (allListings(fallback) || !hasPublishedDates(fallback)))
      ) {
        this.cache.set(cacheKey, { items: fallback, expiresAt: Date.now() + NewsService.CACHE_TTL_MS });
        return fallback;
      }

      const rssFallback = await this.retrieveFromGoogleNewsRss(effectiveQuery, options, numResults);
      if (rssFallback.length > 0) {
        this.cache.set(cacheKey, { items: rssFallback, expiresAt: Date.now() + NewsService.CACHE_TTL_MS });
        return rssFallback;
      }
      this.cache.set(cacheKey, { items: primary, expiresAt: Date.now() + NewsService.CACHE_TTL_MS });
      return primary;
    } catch (error) {
      logger.error('Exa search threw error', { message: (error as Error).message, query, freshness });
      return [];
    }
  }
}
