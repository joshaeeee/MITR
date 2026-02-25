import { z } from 'zod';
import { ReligiousRetriever } from '../retrieval/religious-retriever.js';
import { Mem0Service } from '../memory/mem0-service.js';
import { ReminderService } from '../reminders/reminder-service.js';
import { NewsService } from '../news/news-service.js';
import { CompanionService } from '../companion/companion-service.js';
import { DiaryService } from '../companion/diary-service.js';
import { YoutubeStreamService } from '../media/youtube-stream-service.js';
import { SessionDirectorService } from '../long-session/session-director-service.js';
import { PanchangService } from '../panchang/panchang-service.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';

export interface ToolDeps {
  religiousRetriever: ReligiousRetriever;
  mem0: Mem0Service;
  reminderService: ReminderService;
  newsService: NewsService;
  companionService: CompanionService;
  diaryService: DiaryService;
  sessionDirector: SessionDirectorService;
  youtubeStreamService: YoutubeStreamService;
  panchangService: PanchangService;
}

export interface AgentToolContext {
  userId: string;
  language: string;
  sessionId: string;
  getLastUserTranscript?: () => string | null;
  publishClientEvent?: (event: {
    type: string;
    sourceTool: string;
    requestId?: string;
    payload?: Record<string, unknown>;
  }) => void;
}

export interface AgentToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: TSchema;
  timeoutMs: number;
  execute: (input: z.infer<TSchema>, context: AgentToolContext) => Promise<unknown>;
}

type FlowType = 'satsang' | 'story' | 'companion';

const toSessionBlockResponse = (
  block:
    | {
        id: string;
        seq: number;
        blockType: string;
        payload: {
          completionPolicy?: string;
          phase?: string;
          prompt?: string;
          fixedText?: string;
          maxWords?: number;
          citationRequired?: boolean;
          useRetrieval?: string;
          shlokaId?: string;
          shlokaReference?: string;
          shlokaText?: string;
          arthHint?: string;
          vyakhyaHint?: string;
        };
      }
    | null
) => {
  if (!block) return null;
  return {
    id: block.id,
    seq: block.seq,
    blockType: block.blockType,
    completionPolicy: block.payload.completionPolicy,
    phase: block.payload.phase,
    prompt: block.payload.prompt,
    fixedText: block.payload.fixedText,
    maxWords: block.payload.maxWords,
    citationRequired: block.payload.citationRequired,
    useRetrieval: block.payload.useRetrieval,
    shlokaId: block.payload.shlokaId,
    shlokaReference: block.payload.shlokaReference,
    shlokaText: block.payload.shlokaText,
    arthHint: block.payload.arthHint,
    vyakhyaHint: block.payload.vyakhyaHint
  };
};

const modeToFlowType = (mode: string): FlowType =>
  mode === 'satsang_long' ? 'satsang' : mode === 'story_long' ? 'story' : 'companion';

const flowTypeToMode = (flowType: FlowType): 'satsang_long' | 'story_long' | 'companion_long' =>
  flowType === 'satsang' ? 'satsang_long' : flowType === 'story' ? 'story_long' : 'companion_long';

const resolveLoopMode = (session: { mode: string; metadata?: unknown }): 'interactive' | 'continuous' => {
  if (session.mode !== 'satsang_long') return 'interactive';
  const metadata =
    session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
      ? (session.metadata as Record<string, unknown>)
      : undefined;
  const satsang = metadata?.satsang;
  if (!satsang || typeof satsang !== 'object' || Array.isArray(satsang)) return 'interactive';
  return (satsang as Record<string, unknown>).paceMode === 'continuous' ? 'continuous' : 'interactive';
};

const toFlowResponse = (
  session: {
    longSessionId: string;
    mode: string;
    status: string;
    phase: string;
    topic?: string;
    language?: string;
    metadata?: unknown;
  },
  nextBlock: ReturnType<typeof toSessionBlockResponse> | null
) => {
  const loopMode = resolveLoopMode(session);
  return {
    id: session.longSessionId,
    type: modeToFlowType(session.mode),
    mode: session.mode,
    status: session.status,
    phase: session.phase,
    topic: session.topic,
    language: session.language,
    loopMode,
    nextStep: nextBlock,
    readyForAutoAdvance: loopMode === 'continuous' && nextBlock?.completionPolicy === 'auto'
  };
};

export const createToolDefinitions = (deps: ToolDeps): AgentToolDefinition[] => {
  const NEWS_JOB_TTL_MS = 2 * 60 * 1000;
  const youtubeResolveJobs = new Map<
    string,
    {
      status: 'pending' | 'ready' | 'failed';
      updatedAt: number;
      result?: {
        title?: string;
        searchQuery?: string;
        webpageUrl?: string;
        streamUrl?: string;
      };
      error?: string;
    }
  >();
  const youtubeSearchUrl = (query: string): string =>
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const newsJobsByKey = new Map<
    string,
    {
      requestId: string;
      status: 'pending' | 'ready' | 'failed';
      updatedAt: number;
      result?: {
        items: Array<{
          title: string;
          summary: string;
          source: string;
          url: string;
          publishedAt: string;
        }>;
        quality: {
          listingOnly: boolean;
          hasPublishedDates: boolean;
          confidence: 'low' | 'medium' | 'high';
        };
      };
      error?: string;
    }
  >();
  const religiousJobsByKey = new Map<
    string,
    {
      requestId: string;
      status: 'pending' | 'ready' | 'failed';
      updatedAt: number;
      result?: {
        citations: Array<{
          title: string;
          source: string;
          passage: string;
          tradition?: string;
          language?: string;
        }>;
      };
      error?: string;
    }
  >();
  const storyJobsByKey = new Map<
    string,
    {
      requestId: string;
      status: 'pending' | 'ready' | 'failed';
      updatedAt: number;
      result?: {
        hits: Array<{
          title: string;
          source: string;
          passage: string;
          tradition?: string;
          language?: string;
          storyId?: string;
          region?: string;
          tone?: string;
          moral?: string;
        }>;
      };
      error?: string;
    }
  >();
  const panchangJobsByKey = new Map<
    string,
    {
      requestId: string;
      status: 'pending' | 'ready' | 'failed';
      updatedAt: number;
      result?: Record<string, unknown>;
      error?: string;
    }
  >();
  const nextRequestId = (prefix: string): string =>
    `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const isContinueIntent = (text?: string): boolean => {
    if (!text) return false;
    return /(agla|next|aage|aage badh|continue|चलो आगे|आगे|अगला|next shlok|next shloka|अगला श्लोक)/i.test(text);
  };
  const isNextShlokaIntent = (text?: string): boolean => {
    if (!text) return false;
    const normalized = text.toLowerCase();
    const hints = [
      'next shlok',
      'next shloka',
      'agla shlok',
      'agla shloka',
      'अगला श्लोक',
      'अगले श्लोक',
      'अगला शलोक',
      'अगले शलोक',
      'अगला स्लोक',
      'अगले स्लोक',
      'اگلا شلوک',
      'اگلے شلوک'
    ];
    return hints.some((hint) => normalized.includes(hint));
  };
  const isRestartIntent = (text?: string): boolean => {
    if (!text) return false;
    return /(restart|start over|from beginning|new satsang|naya satsang|फिर से|दोबारा|शुरू से|नया सत्संग)/i.test(text);
  };
  const normalize = (value?: string): string =>
    (value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  const optionalStringArg = () =>
    z.preprocess((value) => (value == null ? undefined : value), z.string().optional());

  const religiousRetrieve: AgentToolDefinition = {
    name: 'religious_retrieve',
    description: 'Retrieve grounded religious/spiritual citations from curated corpus.',
    parameters: z.object({
      query: z.string(),
      language: optionalStringArg(),
      tradition: optionalStringArg(),
      depth: z.enum(['short', 'standard', 'deep']).optional()
    }),
    timeoutMs: 1200,
    execute: async (input, context) => {
      const normalizedInput = {
        query: input.query.trim(),
        language: input.language ?? undefined,
        tradition: input.tradition ?? undefined,
        depth: input.depth ?? undefined
      };
      const key = JSON.stringify(normalizedInput);
      const now = Date.now();
      for (const [jobKey, job] of religiousJobsByKey.entries()) {
        if (now - job.updatedAt > NEWS_JOB_TTL_MS) religiousJobsByKey.delete(jobKey);
      }

      const existing = religiousJobsByKey.get(key);
      if (existing && existing.status === 'ready' && existing.result) {
        return {
          status: 'ready',
          requestId: existing.requestId,
          citations: existing.result.citations
        };
      }
      if (existing && existing.status === 'pending') {
        return {
          status: 'pending',
          requestId: existing.requestId,
          query: normalizedInput.query,
          message: 'Retrieving grounded citations in background.'
        };
      }

      const requestId = nextRequestId('rr');
      religiousJobsByKey.set(key, {
        requestId,
        status: 'pending',
        updatedAt: now
      });

      void deps.religiousRetriever
        .retrieve(normalizedInput)
        .then((citations) => {
          religiousJobsByKey.set(key, {
            requestId,
            status: 'ready',
            updatedAt: Date.now(),
            result: { citations }
          });
          context.publishClientEvent?.({
            type: 'religious_retrieve_ready',
            sourceTool: 'religious_retrieve',
            requestId,
            payload: {
              query: normalizedInput.query,
              language: normalizedInput.language,
              tradition: normalizedInput.tradition,
              depth: normalizedInput.depth,
              citationCount: citations.length,
              citations
            }
          });
        })
        .catch((error) => {
          const message = (error as Error).message || 'Unknown religious retrieval error';
          religiousJobsByKey.set(key, {
            requestId,
            status: 'failed',
            updatedAt: Date.now(),
            error: message
          });
          context.publishClientEvent?.({
            type: 'religious_retrieve_failed',
            sourceTool: 'religious_retrieve',
            requestId,
            payload: {
              query: normalizedInput.query,
              language: normalizedInput.language,
              tradition: normalizedInput.tradition,
              depth: normalizedInput.depth,
              error: message
            }
          });
        });

      return {
        status: 'pending',
        requestId,
        query: normalizedInput.query,
        message: 'Retrieving grounded citations in background.'
      };
    }
  };

  const storyRetrieve: AgentToolDefinition = {
    name: 'story_retrieve',
    description:
      'Retrieve full Indian story passages from Qdrant RAG corpus (Panchatantra, Ramayana, Mahabharata, Akbar-Birbal, Jataka, folk tales).',
    parameters: z.object({
      query: z.string(),
      language: optionalStringArg(),
      tradition: optionalStringArg(),
      region: optionalStringArg(),
      k: z.number().int().min(1).max(10).optional()
    }),
    timeoutMs: 1200,
    execute: async (input, context) => {
      const normalizedInput = {
        query: input.query.trim(),
        language: input.language ?? undefined,
        tradition: input.tradition ?? undefined,
        region: input.region ?? undefined,
        k: input.k ?? undefined
      };
      const key = JSON.stringify(normalizedInput);
      const now = Date.now();
      for (const [jobKey, job] of storyJobsByKey.entries()) {
        if (now - job.updatedAt > NEWS_JOB_TTL_MS) storyJobsByKey.delete(jobKey);
      }

      const existing = storyJobsByKey.get(key);
      if (existing && existing.status === 'ready' && existing.result) {
        return {
          status: 'ready',
          requestId: existing.requestId,
          hits: existing.result.hits
        };
      }
      if (existing && existing.status === 'pending') {
        return {
          status: 'pending',
          requestId: existing.requestId,
          query: normalizedInput.query,
          message: 'Retrieving story passages in background.'
        };
      }

      const requestId = nextRequestId('story');
      storyJobsByKey.set(key, {
        requestId,
        status: 'pending',
        updatedAt: now
      });

      void deps.religiousRetriever
        .retrieveStories(normalizedInput)
        .then((hits) => {
          storyJobsByKey.set(key, {
            requestId,
            status: 'ready',
            updatedAt: Date.now(),
            result: { hits }
          });
          context.publishClientEvent?.({
            type: 'story_retrieve_ready',
            sourceTool: 'story_retrieve',
            requestId,
            payload: {
              query: normalizedInput.query,
              language: normalizedInput.language,
              tradition: normalizedInput.tradition,
              region: normalizedInput.region,
              k: normalizedInput.k,
              hitCount: hits.length,
              hits
            }
          });
        })
        .catch((error) => {
          const message = (error as Error).message || 'Unknown story retrieval error';
          storyJobsByKey.set(key, {
            requestId,
            status: 'failed',
            updatedAt: Date.now(),
            error: message
          });
          context.publishClientEvent?.({
            type: 'story_retrieve_failed',
            sourceTool: 'story_retrieve',
            requestId,
            payload: {
              query: normalizedInput.query,
              language: normalizedInput.language,
              tradition: normalizedInput.tradition,
              region: normalizedInput.region,
              k: normalizedInput.k,
              error: message
            }
          });
        });

      return {
        status: 'pending',
        requestId,
        query: normalizedInput.query,
        message: 'Retrieving story passages in background.'
      };
    }
  };

  const memoryAdd: AgentToolDefinition = {
    name: 'memory_add',
    description: 'Store long-term user memory using Mem0 with Sarvam extraction.',
    parameters: z.object({
      text: z.string(),
      tags: z.array(z.string()).optional(),
      sourceTurnId: optionalStringArg()
    }),
    timeoutMs: 2200,
    execute: async (input, context) => {
      await deps.mem0.addMemory(
        context.userId,
        [
          { role: 'user', content: input.text },
          { role: 'assistant', content: 'Store this as important memory for future conversations.' }
        ],
        { tags: input.tags, sourceTurnId: input.sourceTurnId }
      );
      return { ok: true };
    }
  };

  const memoryGet: AgentToolDefinition = {
    name: 'memory_get',
    description: 'Search long-term memories relevant to user query.',
    parameters: z.object({
      query: z.string(),
      k: z.number().int().min(1).max(20).optional()
    }),
    timeoutMs: 1800,
    execute: async (input, context) => {
      const memories = await deps.mem0.searchMemory(context.userId, input.query, input.k ?? 5);
      return { memories };
    }
  };

  const reminderCreate: AgentToolDefinition = {
    name: 'reminder_create',
    description: 'Create an alarm/reminder for medicines, appointments, and routines.',
    parameters: z.object({
      title: z.string(),
      datetimeISO: z.string(),
      recurrence: optionalStringArg(),
      locale: optionalStringArg(),
      language: optionalStringArg()
    }),
    timeoutMs: 1200,
    execute: async (input, context) => {
      const reminder = await deps.reminderService.create({
        userId: context.userId,
        title: input.title,
        datetimeISO: input.datetimeISO,
        recurrence: input.recurrence,
        locale: input.locale,
        language: input.language ?? context.language
      });
      return { reminderId: reminder.id };
    }
  };

  const reminderList: AgentToolDefinition = {
    name: 'reminder_list',
    description: 'List reminders for the current user.',
    parameters: z.object({}),
    timeoutMs: 1000,
    execute: async (_input, context) => {
      const reminders = await deps.reminderService.listByUser(context.userId);
      return { reminders };
    }
  };

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

  const newsRetrieve: AgentToolDefinition = {
    name: 'news_retrieve',
    description:
      'Retrieve fresh, detailed regional current-affairs coverage from trusted feeds. Set freshness based on user request: latest, recent, or general.',
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
    execute: async (input, context) => {
      const normalizedInput = {
        query: input.query.trim(),
        freshness: input.freshness ?? undefined,
        language: input.language ?? undefined,
        regionCode: input.regionCode ?? undefined,
        stateOrCity: input.stateOrCity ?? undefined,
        numResults: input.numResults ?? undefined,
        recencyDays: input.recencyDays ?? undefined
      };

      const key = JSON.stringify(normalizedInput);
      const now = Date.now();
      for (const [jobKey, job] of newsJobsByKey.entries()) {
        if (now - job.updatedAt > NEWS_JOB_TTL_MS) newsJobsByKey.delete(jobKey);
      }

      const existing = newsJobsByKey.get(key);
      if (existing && existing.status === 'ready' && existing.result) {
        return {
          status: 'ready',
          requestId: existing.requestId,
          items: existing.result.items,
          quality: existing.result.quality
        };
      }
      if (existing && existing.status === 'pending') {
        return {
          status: 'pending',
          requestId: existing.requestId,
          query: normalizedInput.query,
          stateOrCity: normalizedInput.stateOrCity,
          regionCode: normalizedInput.regionCode,
          message: 'Fetching latest regional news in background.'
        };
      }

      const requestId = nextRequestId('news');
      newsJobsByKey.set(key, {
        requestId,
        status: 'pending',
        updatedAt: now
      });

      void deps.newsService
        .retrieve(normalizedInput.query, {
          language: normalizedInput.language,
          regionCode: normalizedInput.regionCode,
          stateOrCity: normalizedInput.stateOrCity,
          numResults: normalizedInput.numResults,
          recencyDays: normalizedInput.recencyDays,
          freshness: normalizedInput.freshness
        })
        .then((items) => {
          const quality = assessNewsQuality(items);
          newsJobsByKey.set(key, {
            requestId,
            status: 'ready',
            updatedAt: Date.now(),
            result: { items, quality }
          });
          context.publishClientEvent?.({
            type: 'news_retrieve_ready',
            sourceTool: 'news_retrieve',
            requestId,
            payload: {
              query: normalizedInput.query,
              stateOrCity: normalizedInput.stateOrCity,
              regionCode: normalizedInput.regionCode,
              freshness: normalizedInput.freshness,
              itemCount: items.length,
              quality,
              items
            }
          });
        })
        .catch((error) => {
          const message = (error as Error).message || 'Unknown news retrieval error';
          newsJobsByKey.set(key, {
            requestId,
            status: 'failed',
            updatedAt: Date.now(),
            error: message
          });
          context.publishClientEvent?.({
            type: 'news_retrieve_failed',
            sourceTool: 'news_retrieve',
            requestId,
            payload: {
              query: normalizedInput.query,
              stateOrCity: normalizedInput.stateOrCity,
              regionCode: normalizedInput.regionCode,
              freshness: normalizedInput.freshness,
              error: message
            }
          });
        });

      return {
        status: 'pending',
        requestId,
        query: normalizedInput.query,
        stateOrCity: normalizedInput.stateOrCity,
        regionCode: normalizedInput.regionCode,
        freshness: normalizedInput.freshness,
        message: 'Fetching latest regional news in background.'
      };
    }
  };

  const panchangGet: AgentToolDefinition = {
    name: 'panchang_get',
    description:
      'Get daily Panchang for a city using grounded astrology API data. Use for tithi, nakshatra, rahu kaal, shubh/ashubh muhurat queries.',
    parameters: z.object({
      city: optionalStringArg(),
      stateOrRegion: optionalStringArg(),
      countryCode: optionalStringArg(),
      dateISO: optionalStringArg(),
      language: optionalStringArg(),
      ayanamsa: z.number().int().nullish(),
      locationConfirmed: z.boolean().nullish()
    }),
    timeoutMs: 1200,
    execute: async (input, context) => {
      const city = (input.city ?? '').trim();
      if (!city) {
        return {
          status: 'needs_city',
          message: 'Please provide city name for Panchang. Location is required.'
        };
      }

      const normalizedInput = {
        city,
        stateOrRegion: input.stateOrRegion ?? undefined,
        countryCode: input.countryCode ?? undefined,
        dateISO: input.dateISO ?? undefined,
        language: input.language ?? context.language,
        ayanamsa: input.ayanamsa ?? undefined,
        locationConfirmed: input.locationConfirmed ?? undefined
      };

      const key = JSON.stringify(normalizedInput);
      const now = Date.now();
      for (const [jobKey, job] of panchangJobsByKey.entries()) {
        if (now - job.updatedAt > NEWS_JOB_TTL_MS) panchangJobsByKey.delete(jobKey);
      }

      const existing = panchangJobsByKey.get(key);
      if (existing && existing.status === 'ready' && existing.result) {
        return {
          status: 'ready',
          requestId: existing.requestId,
          ...existing.result
        };
      }
      if (existing && existing.status === 'pending') {
        return {
          status: 'pending',
          requestId: existing.requestId,
          city: normalizedInput.city,
          stateOrRegion: normalizedInput.stateOrRegion,
          countryCode: normalizedInput.countryCode,
          message: 'Fetching Panchang in background.'
        };
      }

      const requestId = nextRequestId('panchang');
      panchangJobsByKey.set(key, {
        requestId,
        status: 'pending',
        updatedAt: now
      });

      void deps.panchangService
        .getByCity(normalizedInput)
        .then((result) => {
          panchangJobsByKey.set(key, {
            requestId,
            status: 'ready',
            updatedAt: Date.now(),
            result
          });
          context.publishClientEvent?.({
            type: 'panchang_get_ready',
            sourceTool: 'panchang_get',
            requestId,
            payload: {
              city: normalizedInput.city,
              stateOrRegion: normalizedInput.stateOrRegion,
              countryCode: normalizedInput.countryCode,
              result
            }
          });
        })
        .catch((error) => {
          const message = (error as Error).message || 'Unknown panchang error';
          panchangJobsByKey.set(key, {
            requestId,
            status: 'failed',
            updatedAt: Date.now(),
            error: message
          });
          context.publishClientEvent?.({
            type: 'panchang_get_failed',
            sourceTool: 'panchang_get',
            requestId,
            payload: {
              city: normalizedInput.city,
              stateOrRegion: normalizedInput.stateOrRegion,
              countryCode: normalizedInput.countryCode,
              error: message
            }
          });
        });

      return {
        status: 'pending',
        requestId,
        city: normalizedInput.city,
        stateOrRegion: normalizedInput.stateOrRegion,
        countryCode: normalizedInput.countryCode,
        message: 'Fetching Panchang in background.'
      };
    }
  };

  const devotionalPlaylistGet: AgentToolDefinition = {
    name: 'devotional_playlist_get',
    description: 'Get ritual-based devotional playback suggestion with YouTube search URL.',
    parameters: z.object({}),
    timeoutMs: 700,
    execute: async () => deps.companionService.suggestAarti()
  };

  const youtubeMediaGet: AgentToolDefinition = {
    name: 'youtube_media_get',
    description:
      'Resolve YouTube media for playback by query. Use for requests like play news/music/bhajan/live video.',
    parameters: z.object({
      query: z.string(),
      preferLive: z.boolean().optional(),
      preferLatest: z.boolean().optional(),
      regionHint: optionalStringArg(),
      language: optionalStringArg()
    }),
    timeoutMs: env.YOUTUBE_MEDIA_TIMEOUT_MS,
    execute: async (input, context) => {
      const searchQuery = [
        input.query.trim(),
        input.preferLive ? 'live' : '',
        input.preferLatest ? 'today latest' : '',
        input.regionHint ?? '',
        input.language ?? ''
      ]
        .filter(Boolean)
        .join(' ')
        .trim();
      const requestId = nextRequestId('yt');
      const fallbackWebpageUrl = youtubeSearchUrl(searchQuery);

      youtubeResolveJobs.set(requestId, {
        status: 'pending',
        updatedAt: Date.now()
      });

      void deps.youtubeStreamService
        .resolveFromSearch(searchQuery)
        .then((resolved) => {
          youtubeResolveJobs.set(requestId, {
            status: 'ready',
            updatedAt: Date.now(),
            result: {
              title: resolved.title,
              searchQuery: resolved.searchQuery,
              streamUrl: resolved.streamUrl,
              webpageUrl: resolved.webpageUrl
            }
          });
          context.publishClientEvent?.({
            type: 'youtube_media_ready',
            sourceTool: 'youtube_media_get',
            requestId,
            payload: {
              title: resolved.title,
              searchQuery: resolved.searchQuery,
              streamUrl: resolved.streamUrl,
              webpageUrl: resolved.webpageUrl
            }
          });
        })
        .catch((error) => {
          const message = (error as Error).message || 'Unknown youtube resolution error';
          youtubeResolveJobs.set(requestId, {
            status: 'failed',
            updatedAt: Date.now(),
            error: message
          });
          context.publishClientEvent?.({
            type: 'youtube_media_failed',
            sourceTool: 'youtube_media_get',
            requestId,
            payload: {
              searchQuery,
              error: message
            }
          });
        });

      return {
        status: 'pending',
        requestId,
        title: input.query.trim(),
        searchQuery,
        webpageUrl: fallbackWebpageUrl,
        message:
          'Resolving media in background. Continue conversation; playback details will be published when ready.'
      };
    }
  };

  const dailyBriefingGet: AgentToolDefinition = {
    name: 'daily_briefing_get',
    description:
      'Generate a personalized morning briefing: day context, festivals, reminders, and thought of day.',
    parameters: z.object({
      language: optionalStringArg()
    }),
    timeoutMs: 1500,
    execute: async (input, context) => deps.companionService.getDailyBriefing(context.userId, input.language ?? context.language)
  };

  const diaryAdd: AgentToolDefinition = {
    name: 'diary_add',
    description: 'Save user life-story diary entry from voice.',
    parameters: z.object({
      text: z.string(),
      mood: optionalStringArg(),
      tags: z.array(z.string()).optional()
    }),
    timeoutMs: 1000,
    execute: async (input, context) => {
      await deps.diaryService.add(context.userId, {
        ts: Date.now(),
        text: input.text,
        mood: input.mood,
        tags: input.tags
      });
      return { ok: true };
    }
  };

  const diaryList: AgentToolDefinition = {
    name: 'diary_list',
    description: 'Fetch latest voice diary entries for continuity and recall.',
    parameters: z.object({
      limit: z.number().int().min(1).max(30).optional()
    }),
    timeoutMs: 1000,
    execute: async (input, context) => {
      const entries = await deps.diaryService.list(context.userId, input.limit ?? 10);
      return { entries };
    }
  };

  const inferFlowType = (topic?: string, transcript?: string | null): FlowType => {
    const text = `${topic ?? ''} ${transcript ?? ''}`.toLowerCase();
    if (/(satsang|sat-sang|श्लोक|श्लोक|गीता|geeta|bhagavad|भगवद)/i.test(text)) return 'satsang';
    if (/(story|कहानी|katha|पंचतंत्र|ramayana|mahābharat|महाभारत|रामायण)/i.test(text)) return 'story';
    return 'companion';
  };

  const runFlowStart = async (
    input: {
      flowType?: FlowType | null;
      topic?: string | null;
      language?: string | null;
      targetDurationSec?: number | null;
      paceMode?: 'interactive' | 'continuous' | null;
      targetShlokaCount?: number | null;
      resumeIfRunning?: boolean | null;
      restart?: boolean | null;
      autoLoop?: boolean | null;
    },
    context: AgentToolContext
  ) => {
    const lastTranscript = context.getLastUserTranscript?.() ?? null;
    const flowType = input.flowType ?? inferFlowType(input.topic ?? undefined, lastTranscript);
    const mode = flowTypeToMode(flowType);

    const active = await deps.sessionDirector.getByUserRunning(context.userId);
    if (active) {
      const requestedTopic = normalize(input.topic ?? undefined);
      const activeTopic = normalize(active.topic);
      const topicChanged = requestedTopic.length > 0 && requestedTopic !== activeTopic;
      const sameMode = active.mode === mode;
      const wantsRestart = input.restart === true || isRestartIntent(lastTranscript ?? undefined) || topicChanged;
      const shouldResume = (input.resumeIfRunning ?? true) && sameMode && !wantsRestart;

      if (shouldResume) {
        const nextBlock = await deps.sessionDirector.next(active.longSessionId);
        if (nextBlock) {
          return {
            ok: true,
            resumed: true,
            flow: toFlowResponse(active, toSessionBlockResponse(nextBlock)),
            autoLoop: input.autoLoop ?? resolveLoopMode(active) === 'continuous'
          };
        }
      }
      await deps.sessionDirector.stop(active.longSessionId, 'superseded_by_flow_start');
    }

    const started = await deps.sessionDirector.start({
      userId: context.userId,
      mode,
      topic: input.topic ?? undefined,
      targetDurationSec: input.targetDurationSec ?? undefined,
      language: input.language ?? context.language,
      resumeIfRunning: false,
      paceMode: input.paceMode ?? undefined,
      targetShlokaCount: input.targetShlokaCount ?? undefined
    });

    return {
      ok: true,
      resumed: false,
      flow: toFlowResponse(started.session, toSessionBlockResponse(started.nextBlock)),
      autoLoop: input.autoLoop ?? resolveLoopMode(started.session) === 'continuous'
    };
  };

  const runFlowNext = async (
    input: {
      flowId?: string | null;
      action?: 'continue' | 'reflect' | 'question' | 'summarize' | 'close' | 'new_text' | null;
      query?: string | null;
      auto?: boolean | null;
      skipToNext?: boolean | null;
    },
    context: AgentToolContext
  ) => {
    const inferredQueryRaw = input.query ?? context.getLastUserTranscript?.() ?? undefined;
    const inferredQuery =
      typeof inferredQueryRaw === 'string' && inferredQueryRaw.trim().length > 0
        ? inferredQueryRaw.trim()
        : undefined;
    const requestedAction = input.action ?? 'continue';

    const active = input.flowId
      ? await deps.sessionDirector.get(input.flowId)
      : await deps.sessionDirector.getByUserRunning(context.userId);
    if (!active) {
      return { ok: false, error: 'No active flow. Start with flow_start.' };
    }
    if (requestedAction === 'close') {
      const stopped = await deps.sessionDirector.stop(active.longSessionId, 'flow_close_action');
      return {
        ok: true,
        closed: true,
        flow: stopped ? toFlowResponse(stopped, null) : null
      };
    }

    if (active.currentBlockId) {
      await deps.sessionDirector.completeBlock({
        longSessionId: active.longSessionId,
        blockId: active.currentBlockId,
        state: 'done',
        result: {
          action: requestedAction,
          ...(inferredQuery ? { userInput: inferredQuery } : {})
        }
      });
    }

    const refreshed = await deps.sessionDirector.get(active.longSessionId);
    if (!refreshed || refreshed.status !== 'running') {
      return { ok: false, error: 'Flow session is no longer running.' };
    }

    const explicitContinue = requestedAction === 'continue' || isContinueIntent(inferredQuery) || input.auto === true;
    const explicitNextShloka =
      refreshed.mode === 'satsang_long' && (input.skipToNext === true || isNextShlokaIntent(inferredQuery));

    let nextBlock = await deps.sessionDirector.next(active.longSessionId);
    let skippedReflection = false;
    let skippedRecap = false;
    let skippedToNextShloka = false;

    for (let i = 0; i < 10 && nextBlock; i += 1) {
      if (explicitNextShloka && nextBlock.payload?.phase !== 'shastra_path') {
        await deps.sessionDirector.completeBlock({
          longSessionId: active.longSessionId,
          blockId: nextBlock.id,
          state: 'skipped',
          result: {
            reason: 'auto_skip_to_next_shloka',
            ...(inferredQuery ? { userInput: inferredQuery } : {})
          }
        });
        skippedToNextShloka = true;
        nextBlock = await deps.sessionDirector.next(active.longSessionId);
        continue;
      }

      if (explicitContinue && nextBlock.blockType === 'ask_user') {
        await deps.sessionDirector.completeBlock({
          longSessionId: active.longSessionId,
          blockId: nextBlock.id,
          state: 'skipped',
          result: {
            reason: 'auto_skip_reflection_on_continue',
            ...(inferredQuery ? { userInput: inferredQuery } : {})
          }
        });
        skippedReflection = true;
        nextBlock = await deps.sessionDirector.next(active.longSessionId);
        continue;
      }

      if (explicitContinue && nextBlock.blockType === 'recap') {
        await deps.sessionDirector.completeBlock({
          longSessionId: active.longSessionId,
          blockId: nextBlock.id,
          state: 'skipped',
          result: {
            reason: 'auto_skip_recap_on_continue',
            ...(inferredQuery ? { userInput: inferredQuery } : {})
          }
        });
        skippedRecap = true;
        nextBlock = await deps.sessionDirector.next(active.longSessionId);
        continue;
      }

      break;
    }

    const latest = (await deps.sessionDirector.get(active.longSessionId)) ?? refreshed;
    return {
      ok: true,
      requestedAction,
      query: inferredQuery,
      skippedReflection,
      skippedRecap,
      skippedToNextShloka,
      flow: toFlowResponse(latest, toSessionBlockResponse(nextBlock))
    };
  };

  const runFlowStop = async (input: { flowId?: string | null; reason?: string | null }, context: AgentToolContext) => {
    const active = input.flowId
      ? await deps.sessionDirector.get(input.flowId)
      : await deps.sessionDirector.getByUserRunning(context.userId);
    if (!active) {
      return { ok: false, error: 'No active flow to stop.' };
    }
    const stopped = await deps.sessionDirector.stop(active.longSessionId, input.reason ?? 'flow_stop');
    return {
      ok: true,
      flow: stopped ? toFlowResponse(stopped, null) : null
    };
  };

  const flowStart: AgentToolDefinition = {
    name: 'flow_start',
    description:
      'Start or resume a structured flow (satsang/story/companion). Returns flow + nextStep for the immediate spoken response.',
    parameters: z.object({
      flowType: z.enum(['satsang', 'story', 'companion']).nullish(),
      topic: z.string().nullish(),
      language: z.string().nullish(),
      targetDurationSec: z.number().int().min(300).max(7200).nullish(),
      paceMode: z.enum(['interactive', 'continuous']).nullish(),
      targetShlokaCount: z.number().int().min(2).max(8).nullish(),
      resumeIfRunning: z.boolean().nullish(),
      restart: z.boolean().nullish(),
      autoLoop: z.boolean().nullish()
    }),
    timeoutMs: 15000,
    execute: async (input, context) => runFlowStart(input, context)
  };

  const flowNext: AgentToolDefinition = {
    name: 'flow_next',
    description:
      'Advance active structured flow and return nextStep to speak. Use auto=true for hands-free progression in continuous mode.',
    parameters: z.object({
      flowId: z.string().nullish(),
      action: z.enum(['continue', 'reflect', 'question', 'summarize', 'close', 'new_text']).nullish(),
      query: z.string().nullish(),
      auto: z.boolean().nullish(),
      skipToNext: z.boolean().nullish()
    }),
    timeoutMs: 20000,
    execute: async (input, context) => runFlowNext(input, context)
  };

  const flowStop: AgentToolDefinition = {
    name: 'flow_stop',
    description: 'Stop the active structured flow.',
    parameters: z.object({
      flowId: z.string().nullish(),
      reason: z.string().nullish()
    }),
    timeoutMs: 2000,
    execute: async (input, context) => runFlowStop(input, context)
  };

  const pranayamaGuideGet: AgentToolDefinition = {
    name: 'pranayama_guide_get',
    description: 'Get guided breathing steps for calming and emotional support.',
    parameters: z.object({
      minutes: z.number().int().min(2).max(20).optional()
    }),
    timeoutMs: 800,
    execute: async (input) => deps.companionService.getPranayamaGuide(input.minutes ?? 5)
  };

  const brainGameGet: AgentToolDefinition = {
    name: 'brain_game_get',
    description: 'Get memory/cognitive game prompts (riddle, shloka completion, quick math).',
    parameters: z.object({
      type: optionalStringArg()
    }),
    timeoutMs: 800,
    execute: async (input) => deps.companionService.getBrainGame(input.type ?? 'riddle')
  };

  const festivalContextGet: AgentToolDefinition = {
    name: 'festival_context_get',
    description: 'Get festival-day guidance and ritual context for today.',
    parameters: z.object({}),
    timeoutMs: 800,
    execute: async () => deps.companionService.getFestivalCompanion()
  };

  const medicationAdherenceSetup: AgentToolDefinition = {
    name: 'medication_adherence_setup',
    description:
      'Create medication reminder plus two follow-up reminders (after 10 and 20 minutes) to improve adherence.',
    parameters: z.object({
      medicine: z.string(),
      datetimeISO: z.string(),
      recurrence: optionalStringArg(),
      locale: optionalStringArg(),
      language: optionalStringArg()
    }),
    timeoutMs: 2500,
    execute: async (input, context) => {
      const baseTime = new Date(input.datetimeISO);
      if (Number.isNaN(baseTime.getTime())) {
        return { ok: false, error: 'Invalid datetimeISO' };
      }

      const created: string[] = [];
      const base = await deps.reminderService.create({
        userId: context.userId,
        title: `Dawai: ${input.medicine}`,
        datetimeISO: baseTime.toISOString(),
        recurrence: input.recurrence,
        locale: input.locale,
        language: input.language ?? context.language
      });
      created.push(base.id);

      const followup1 = await deps.reminderService.create({
        userId: context.userId,
        title: `Follow-up: Dawai li kya? (${input.medicine})`,
        datetimeISO: new Date(baseTime.getTime() + 10 * 60 * 1000).toISOString(),
        locale: input.locale,
        language: input.language ?? context.language
      });
      created.push(followup1.id);

      const followup2 = await deps.reminderService.create({
        userId: context.userId,
        title: `Second follow-up: Kripya dawai le lijiye (${input.medicine})`,
        datetimeISO: new Date(baseTime.getTime() + 20 * 60 * 1000).toISOString(),
        locale: input.locale,
        language: input.language ?? context.language
      });
      created.push(followup2.id);

      return { ok: true, reminderIds: created };
    }
  };

  const definitions: AgentToolDefinition[] = [
    religiousRetrieve,
    storyRetrieve,
    memoryAdd,
    memoryGet,
    reminderCreate,
    reminderList,
    newsRetrieve,
    panchangGet,
    devotionalPlaylistGet,
    youtubeMediaGet,
    dailyBriefingGet,
    diaryAdd,
    diaryList,
    flowStart,
    flowNext,
    flowStop,
    pranayamaGuideGet,
    brainGameGet,
    festivalContextGet,
    medicationAdherenceSetup
  ];

  logger.info('Agent tools registered', {
    tools: definitions.map((tool) => tool.name)
  });

  return definitions;
};
