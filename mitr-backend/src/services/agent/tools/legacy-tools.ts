import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ReligiousRetriever } from '../../retrieval/religious-retriever.js';
import { Mem0Service, MITR_MEM0_CUSTOM_INSTRUCTIONS, mem0UserIdFor } from '../../memory/mem0-service.js';
import { ReminderService } from '../../reminders/reminder-service.js';
import { NewsService } from '../../news/news-service.js';
import { CompanionService } from '../../companion/companion-service.js';
import { DiaryService } from '../../companion/diary-service.js';
import { YoutubeStreamService } from '../../media/youtube-stream-service.js';
import { SessionDirectorService } from '../../long-session/session-director-service.js';
import { PanchangService } from '../../panchang/panchang-service.js';
import { WebSearchService } from '../../web/web-search-service.js';
import { logger } from '../../../lib/logger.js';
import { env } from '../../../config/env.js';
import { NudgesService } from '../../nudges/nudges-service.js';
import { ElderJourneyService } from '../../elder-journey/elder-journey-service.js';
import type { ConversationTriggerType, PromptResponseState, PromptSentiment } from '../../elder-journey/elder-journey-types.js';
import { ElderContextService } from '../../memory/elder-context-service.js';
import type { ContextCardEventType, ContextCardType, MemoryType, MentionPolicy } from '../../memory/elder-context-types.js';

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
  webSearchService: WebSearchService;
  nudgesService: NudgesService;
  elderJourneyService: ElderJourneyService;
  elderContextService: ElderContextService;
}

export interface AgentToolContext {
  userId: string;
  deviceId?: string;
  familyId?: string;
  elderId?: string;
  language: string;
  sessionId: string;
  getLastUserTranscript?: () => string | null;
  onToolExecutionStart?: (event: {
    name: string;
    startedAt: number;
    payload: unknown;
  }) => void;
  onToolExecutionEnd?: (event: {
    name: string;
    startedAt: number;
    endedAt: number;
    ok: boolean;
    error?: string;
  }) => void;
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

const SKILL_FILES: Record<string, string> = {
  memory_protocol: 'memory_protocol.md'
};

const loadSkillMarkdown = async (skillName: string): Promise<string> => {
  const filename = SKILL_FILES[skillName];
  if (!filename) throw new Error(`Unknown Reca skill: ${skillName}`);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), '.context', 'reca-skills', filename),
    join(moduleDir, '..', 'skills', filename),
    join(process.cwd(), 'src', 'services', 'agent', 'skills', filename)
  ];

  for (const path of candidates) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  throw new Error(`Reca skill file not found: ${filename}`);
};

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

type LegacyToolOptions = {
  includeAsyncTools?: boolean;
  logRegistration?: boolean;
};

export const createLegacyToolDefinitions = (
  deps: ToolDeps,
  options: LegacyToolOptions = {}
): AgentToolDefinition[] => {
  const includeAsyncTools = options.includeAsyncTools ?? true;
  const logRegistration = options.logRegistration ?? true;
  const NEWS_JOB_TTL_MS = 2 * 60 * 1000;
  const MIN_NEWS_RESULTS = 5;
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
  const webSearchJobsByKey = new Map<
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
      };
      error?: string;
    }
  >();
  const nextRequestId = (prefix: string): string =>
    `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

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
  const parseOptionalDate = (value?: string | null): Date | undefined => {
    if (!value) return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };
  const memoryTypeSchema = z.enum([
    'profile',
    'preference',
    'routine',
    'relationship',
    'health_context',
    'semantic',
    'episodic',
    'procedural',
    'boundary'
  ]);
  const contextCardTypeSchema = z.enum([
    'medication_followup',
    'reminder_followup',
    'event_followup',
    'family_nudge',
    'routine_checkin',
    'preference_learning',
    'care_signal',
    'content_offer',
    'conversation_repair'
  ]);
  const mentionPolicySchema = z.enum([
    'immediate',
    'first_safe_user_turn',
    'after_current_request',
    'when_conversational',
    'only_if_user_asks'
  ]);
  const contextCardEventSchema = z.enum([
    'mentioned',
    'answered',
    'completed',
    'dismissed',
    'ignored',
    'snoozed',
    'expired'
  ]);
  const conversationTriggerSchema = z.enum([
    'session_start',
    'first_use',
    'reminder_fired',
    'reminder_acknowledged',
    'medication_taken',
    'medication_delayed',
    'routine_time',
    'morning',
    'evening',
    'caregiver_nudge',
    'user_quiet',
    'user_requested',
    'manual'
  ]);
  const inferMemoryType = (text: string, tags?: string[]): MemoryType => {
    const hay = `${text} ${(tags ?? []).join(' ')}`.toLowerCase();
    if (/routine|habit|daily|roz|yoga|walk|chai|prayer|bhajan/.test(hay)) return 'routine';
    if (/like|prefer|pasand|choice|dislike|avoid/.test(hay)) return 'preference';
    if (/son|daughter|wife|husband|family|brother|sister|beta|beti/.test(hay)) return 'relationship';
    if (/medicine|tablet|dose|doctor|health|dawa|dawai/.test(hay)) return 'health_context';
    if (/do not|avoid|boundary|never/.test(hay)) return 'boundary';
    return 'semantic';
  };
  const contentHash = (value: string): string => createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  const memoryImportance = (text: string, tags?: string[]): number =>
    tags?.some((tag: string) => /medicine|health|family|routine/i.test(tag)) ||
    /medicine|tablet|dose|doctor|health|dawa|dawai|routine|daily|family|beta|beti/i.test(text)
      ? 75
      : 60;
  const memorySubject = (text: string, tags?: string[]): string =>
    tags?.find((tag) => tag.trim().length > 0)?.trim() ?? inferMemoryType(text, tags);
  const contextMemoryQuery = (triggerType?: string | null): string => {
    if (triggerType === 'morning' || triggerType === 'routine_time') {
      return 'important routines habits morning preferences recurring activities';
    }
    if (triggerType === 'medication_taken' || triggerType === 'medication_delayed' || triggerType === 'reminder_fired') {
      return 'medication routines health preferences reminders care context';
    }
    if (triggerType === 'caregiver_nudge') {
      return 'family relationships caregiver preferences boundaries';
    }
    return 'important user preferences routines relationships boundaries hobbies spiritual interests';
  };
  type PanchangQueryType = 'today_snapshot' | 'next_tithi' | 'upcoming_tithi_dates' | 'tithi_on_date';
  const INDIA_TIMEZONE = 'Asia/Kolkata';
  const FESTIVAL_HINTS: Array<{
    key: string;
    aliases: string[];
    tithiKey: string;
    monthFilter: number[];
    lookaheadDays: number;
  }> = [
    {
      key: 'diwali',
      aliases: ['diwali', 'deepawali', 'दीवाली', 'दिवाली', 'दीपावली', 'دیوالی'],
      tithiKey: 'amavasya',
      monthFilter: [10, 11],
      lookaheadDays: 365
    }
  ];
  const TITHI_ALIASES: Record<string, string[]> = {
    pratipada: ['pratipada', 'pratipat', 'प्रतिपदा', 'padwa', 'पड़वा'],
    dvitiya: ['dvitiya', 'dwitiya', 'द्वितीया', 'dooj', 'दूज'],
    tritiya: ['tritiya', 'तृतीया', 'teej', 'तीज'],
    chaturthi: ['chaturthi', 'चतुर्थी', 'chauth', 'चौथ'],
    panchami: ['panchami', 'पंचमी'],
    shashthi: ['shashthi', 'षष्ठी', 'sasthi'],
    saptami: ['saptami', 'सप्तमी'],
    ashtami: ['ashtami', 'asthami', 'अष्टमी', 'ashtmi'],
    navami: ['navami', 'नवमी'],
    dashami: ['dashami', 'दशमी'],
    ekadashi: ['ekadashi', 'ekadsi', 'एकादशी'],
    dvadashi: ['dvadashi', 'द्वादशी', 'baras', 'बारस'],
    trayodashi: ['trayodashi', 'त्रयोदशी', 'teras', 'तेरस'],
    chaturdashi: ['chaturdashi', 'चतुर्दशी', 'chaudas', 'चौदस'],
    purnima: ['purnima', 'poornima', 'पूर्णिमा', 'poonam', 'पूर्णमासी'],
    amavasya: ['amavasya', 'amavas', 'अमावस्या', 'amavasai']
  };
  const normalizeForMatch = (value?: string): string =>
    (value ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const resolveTithiKey = (raw?: string): string | undefined => {
    const target = normalizeForMatch(raw);
    if (!target) return undefined;
    for (const [key, aliases] of Object.entries(TITHI_ALIASES)) {
      if (aliases.some((alias) => normalizeForMatch(alias) === target)) return key;
    }
    for (const [key, aliases] of Object.entries(TITHI_ALIASES)) {
      if (aliases.some((alias) => target.includes(normalizeForMatch(alias)))) return key;
    }
    return undefined;
  };
  const extractTithiKeyFromText = (text?: string): string | undefined => {
    const normalized = normalizeForMatch(text);
    if (!normalized) return undefined;
    for (const [key, aliases] of Object.entries(TITHI_ALIASES)) {
      if (aliases.some((alias) => normalized.includes(normalizeForMatch(alias)))) return key;
    }
    return undefined;
  };
  const detectFestivalHint = (text?: string) => {
    const normalized = normalizeForMatch(text);
    if (!normalized) return undefined;
    return FESTIVAL_HINTS.find((hint) =>
      hint.aliases.some((alias) => normalized.includes(normalizeForMatch(alias)))
    );
  };
  const inferPanchangQueryType = (
    raw: PanchangQueryType | undefined,
    userText: string | undefined,
    tithiKey: string | undefined,
    festivalHintKey?: string
  ): PanchangQueryType => {
    if (raw) return raw;
    const normalized = normalizeForMatch(userText);
    const asksWhen = /(kab|when|कब|next|agla|आगामी|aane wali|आने वाली)/i.test(normalized);
    const asksList = /(list|saari|कितनी|upcoming|आने वाली तिथियां|next 2|next 3)/i.test(normalized);
    if (festivalHintKey && asksWhen) return 'next_tithi';
    if (tithiKey && asksList) return 'upcoming_tithi_dates';
    if (tithiKey && asksWhen) return 'next_tithi';
    if (tithiKey) return 'next_tithi';
    if (/(on|date|को|ke din)/i.test(normalized) && /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-]\d{1,2}/i.test(normalized)) {
      return 'tithi_on_date';
    }
    return 'today_snapshot';
  };
  const clampInt = (value: number, min: number, max: number): number => Math.min(Math.max(Math.trunc(value), min), max);
  const toIstDateISO = (date: Date): string => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: INDIA_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year ?? '1970'}-${parts.month ?? '01'}-${parts.day ?? '01'}`;
  };
  const addDaysIst = (baseDateISO: string | undefined, offsetDays: number): string => {
    const base = baseDateISO && /^\d{4}-\d{2}-\d{2}$/.test(baseDateISO)
      ? new Date(`${baseDateISO}T00:00:00+05:30`)
      : new Date();
    const shifted = new Date(base.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    return toIstDateISO(shifted);
  };
  const computeSearchStartOffset = (
    baseDateISO: string | undefined,
    monthFilter: number[] | undefined,
    lookaheadDays: number
  ): number => {
    if (!monthFilter || monthFilter.length === 0) return 0;
    const base = baseDateISO && /^\d{4}-\d{2}-\d{2}$/.test(baseDateISO)
      ? new Date(`${baseDateISO}T00:00:00+05:30`)
      : new Date();
    const baseYear = Number(toIstDateISO(base).slice(0, 4));
    const targetMonths = [...new Set(monthFilter)].filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
    for (let yearOffset = 0; yearOffset <= 1; yearOffset += 1) {
      const year = baseYear + yearOffset;
      for (const month of targetMonths) {
        const candidate = new Date(`${year}-${String(month).padStart(2, '0')}-01T00:00:00+05:30`);
        const diffDays = Math.floor((candidate.getTime() - base.getTime()) / (24 * 60 * 60 * 1000));
        if (diffDays >= 0 && diffDays <= lookaheadDays) return diffDays;
      }
    }
    return 0;
  };
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const asNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const readCurrentTithi = (payload: Record<string, unknown>): { name?: string; paksha?: string; start?: string; end?: string } => {
    const panchang = asRecord(payload.panchang);
    const tithi = asRecord(panchang?.tithi);
    return {
      name: typeof tithi?.name === 'string' ? tithi.name : undefined,
      paksha: typeof tithi?.paksha === 'string' ? tithi.paksha : undefined,
      start: typeof tithi?.start === 'string' ? tithi.start : undefined,
      end: typeof tithi?.end === 'string' ? tithi.end : undefined
    };
  };
  const matchesTithi = (name: string | undefined, expectedKey: string | undefined): boolean => {
    if (!name || !expectedKey) return false;
    const normalizedName = normalizeForMatch(name);
    return (TITHI_ALIASES[expectedKey] ?? []).some((alias) => normalizedName.includes(normalizeForMatch(alias)));
  };

  const religiousRetrieve: AgentToolDefinition = {
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
      'Use for story requests. Retrieves grounded Indian story passages (Panchatantra/Ramayana/Mahabharata/Akbar-Birbal/Jataka/folk). Returns ready|pending; if pending, acknowledge briefly and continue naturally.',
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
    description:
      "Store a single personal fact the user has explicitly asked you to remember. Explicit remember requests always use this tool, not context_memory_add. Call when the user says something like 'yaad rakhna', 'remember this', 'note kar lo', 'isko save kar lo', or 'bhoolna mat'. Save only the fact they asked you to remember. Do not use for structured artifacts like plans or routines - those use mem0_memory_add. Do not use for silent relationship memory like preferences and habits when the user did not ask you to remember them - those use context_memory_add.",
    parameters: z.object({
      text: z.string(),
      tags: z.array(z.string()).optional(),
      sourceTurnId: optionalStringArg()
    }),
    timeoutMs: 6000,
    execute: async (input, context) => {
      const memoryType = inferMemoryType(input.text, input.tags);
      const subject = memorySubject(input.text, input.tags);
      const importance = memoryImportance(input.text, input.tags);
      const mem0UserId = mem0UserIdFor(context.userId, context.elderId);
      const registry = await deps.elderContextService.addMemoryItem({
        userId: context.userId,
        elderId: context.elderId,
        memoryType,
        subject,
        importance,
        confidence: 82,
        sourceType: 'user_statement',
        sourceId: input.sourceTurnId,
        visibility: memoryType === 'health_context' || memoryType === 'routine' ? 'caregiver_visible' : 'private',
        mem0UserId,
        mem0Status: 'pending',
        contentHash: contentHash(input.text),
        metadata: {
          tags: input.tags ?? [],
          contentSource: 'mem0',
          captureMode: 'explicit',
          sourceTextChars: input.text.length
        }
      });
      if (!registry.ok) return { memorySaved: false, error: registry.error };
      if (registry.existing) {
        return {
          memorySaved: true,
          memoryQueued: false,
          deduped: true,
          registryId: registry.memoryId,
          mem0UserId
        };
      }

      try {
        const mem0 = await deps.mem0.addScopedMemory({
          userId: context.userId,
          elderId: context.elderId,
          messages: [
            { role: 'user', content: input.text },
            { role: 'assistant', content: 'Store this as important memory for future conversations.' }
          ],
          metadata: {
            registryId: registry.memoryId,
            memoryType,
            subject,
            visibility: memoryType === 'health_context' || memoryType === 'routine' ? 'caregiver_visible' : 'private',
            importance,
            confidence: 82,
            sourceType: 'user_statement',
            sourceTurnId: input.sourceTurnId ?? null,
            tags: input.tags ?? []
          },
          customInstructions: MITR_MEM0_CUSTOM_INSTRUCTIONS
        });
        await deps.elderContextService.updateMemoryMem0State({
          userId: context.userId,
          elderId: context.elderId,
          memoryId: registry.memoryId,
          mem0EventId: mem0.eventId,
          mem0Status: mem0.status === 'FAILED' ? 'failed' : 'pending'
        });
        return {
          memorySaved: mem0.status !== 'FAILED',
          memoryQueued: mem0.status !== 'FAILED',
          registryId: registry.memoryId,
          mem0UserId,
          mem0EventId: mem0.eventId,
          mem0Status: mem0.status
        };
      } catch (error) {
        logger.warn('memory_add failed', {
          userId: context.userId,
          sessionId: context.sessionId,
          error: (error as Error).message
        });
        await deps.elderContextService.updateMemoryMem0State({
          userId: context.userId,
          elderId: context.elderId,
          memoryId: registry.memoryId,
          mem0Status: 'failed',
          error: (error as Error).message
        });
        return {
          memorySaved: false,
          registryId: registry.memoryId,
          mem0UserId,
          error: 'Mem0 memory write failed; memory content was not stored.',
          mem0Error: (error as Error).message
        };
      }
    }
  };

  const recaSkillGet: AgentToolDefinition = {
    name: 'reca_skill_get',
    description:
      "Load a Reca runtime skill that returns instructions for a structured workflow. Call with skillName='memory_protocol' before generating any reusable artifact for the user - a fitness plan, diet plan, study schedule, routine, budget, tracker, or recipe. You must wait for the returned instructions before generating the artifact. The returned MD file tells you what to do next, including how to save the artifact to Mem0.",
    parameters: z.object({
      skillName: z.enum(['memory_protocol'])
    }),
    timeoutMs: 900,
    execute: async (input) => ({
      ok: true,
      skillName: input.skillName,
      format: 'markdown',
      content: await loadSkillMarkdown(input.skillName)
    })
  };

  const mem0MemoryAdd: AgentToolDefinition = {
    name: 'mem0_memory_add',
    description:
      'Save a structured memory to Mem0. Call this immediately after generating any reusable artifact (plan, routine, schedule, tracker, budget, recipe). Save the full artifact text, not a summary. Use infer=false and set category to match the artifact type (fitness_plan, meal_plan, study_plan, etc.). Also call this to append a log entry when the user reports progress, completion, or a skip - use the corresponding log category (workout_log, food_log, study_log). Do not announce the save to the user.',
    parameters: z.object({
      text: z.string().min(1),
      metadata: z.record(z.unknown()).optional(),
      infer: z.boolean().optional()
    }),
    timeoutMs: 6000,
    execute: async (input, context) => {
      const result = await deps.mem0.addScopedMemory({
        userId: context.userId,
        elderId: context.elderId,
        messages: [{ role: 'user', content: input.text }],
        metadata: {
          ...(input.metadata ?? {}),
          captureMode: 'mem0_protocol_tool'
        },
        infer: input.infer ?? false
      });
      return {
        ok: result.status !== 'FAILED',
        mem0Status: result.status,
        mem0EventId: result.eventId,
        message: result.message
      };
    }
  };

  const mem0MemorySearch: AgentToolDefinition = {
    name: 'mem0_memory_search',
    description:
      'Search structured Mem0 memories in the current Reca user scope. Use this when the user asks to recall, continue, update, or inspect a saved plan, routine, schedule, tracker, budget, recipe, or log and you do not yet know the memory ID. Provide a specific query and metadata filters such as category, status, domain, object_type, or record_kind when known. Do not use this for general conversation context; use memory_get or context_packet_get instead.',
    parameters: z.object({
      query: z.string().min(1),
      filters: z.record(z.unknown()).optional(),
      limit: z.number().int().min(1).max(20).optional()
    }),
    timeoutMs: 4200,
    execute: async (input, context) => {
      const memories = await deps.mem0.searchScopedMemories({
        userId: context.userId,
        elderId: context.elderId,
        query: input.query,
        filters: input.filters,
        limit: input.limit ?? 5
      });
      return { ok: true, memories };
    }
  };

  const mem0MemoryList: AgentToolDefinition = {
    name: 'mem0_memory_list',
    description:
      'List structured Mem0 memories by metadata filters in the current Reca user scope. Use when browsing a known category/domain before updating a document, creating a rollup, or finding the active version of a saved artifact. Keep limits small unless the user explicitly asks to see many records.',
    parameters: z.object({
      filters: z.record(z.unknown()).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional()
    }),
    timeoutMs: 4200,
    execute: async (input, context) => ({
      ok: true,
      ...(await deps.mem0.listScopedMemories({
        userId: context.userId,
        elderId: context.elderId,
        filters: input.filters,
        limit: input.limit ?? 20,
        page: input.page
      }))
    })
  };

  const mem0MemoryGet: AgentToolDefinition = {
    name: 'mem0_memory_get',
    description:
      'Get one structured Mem0 memory by memory ID after scoped search/list found it. Use before updating or quoting a saved artifact so you have the exact current content. Do not invent memory IDs.',
    parameters: z.object({
      memoryId: optionalStringArg(),
      memory_id: optionalStringArg()
    }),
    timeoutMs: 4200,
    execute: async (input, context) => {
      const memoryId = input.memoryId ?? input.memory_id;
      if (!memoryId) return { ok: false, error: 'memoryId is required' };
      return {
        ok: true,
        memory: await deps.mem0.getScopedMemory({
          userId: context.userId,
          elderId: context.elderId,
          memoryId
        })
      };
    }
  };

  const mem0MemoryUpdate: AgentToolDefinition = {
    name: 'mem0_memory_update',
    description:
      'Update one structured Mem0 memory by memory ID. Use for living documents, active snapshots, plans, routines, trackers, budgets, recipes, or rollups. Do not use for append-only logs unless correcting a mistake; append progress or completion logs with mem0_memory_add instead. Save the full updated text rather than a terse summary.',
    parameters: z.object({
      memoryId: optionalStringArg(),
      memory_id: optionalStringArg(),
      text: z.string().min(1),
      metadata: z.record(z.unknown()).optional()
    }),
    timeoutMs: 6000,
    execute: async (input, context) => {
      const memoryId = input.memoryId ?? input.memory_id;
      if (!memoryId) return { ok: false, error: 'memoryId is required' };
      return {
        ok: true,
        memory: await deps.mem0.updateScopedMemory({
          userId: context.userId,
          elderId: context.elderId,
          memoryId,
          text: input.text,
          metadata: input.metadata
        })
      };
    }
  };

  const mem0MemoryDelete: AgentToolDefinition = {
    name: 'mem0_memory_delete',
    description:
      'Delete one Mem0 memory by memory ID only when the user explicitly asks to delete, remove, or forget that specific saved artifact or memory. Search/list first if the memory ID is unknown. Do not delete based on vague dissatisfaction or inferred preference changes.',
    parameters: z.object({
      memoryId: optionalStringArg(),
      memory_id: optionalStringArg()
    }),
    timeoutMs: 6000,
    execute: async (input, context) => {
      const memoryId = input.memoryId ?? input.memory_id;
      if (!memoryId) return { ok: false, error: 'memoryId is required' };
      return deps.mem0.deleteScopedMemory({
        userId: context.userId,
        elderId: context.elderId,
        memoryId
      });
    }
  };

  const memoryGet: AgentToolDefinition = {
    name: 'memory_get',
    description:
      'Retrieve relevant personal memories when the user asks what you remember, asks to recall a saved detail, or a direct answer depends on explicit saved memory. If no memory is returned, say only that you could not confirm it from saved memory right now; never claim the user never said it.',
    parameters: z.object({
      query: z.string(),
      k: z.number().int().min(1).max(20).optional()
    }),
    timeoutMs: 4200,
    execute: async (input, context) => {
      try {
        const results = await deps.mem0.searchScopedMemories({
          userId: context.userId,
          elderId: context.elderId,
          query: input.query,
          limit: input.k ?? 5
        });
        const authorized = await deps.elderContextService.authorizeMem0SearchResults({
          userId: context.userId,
          elderId: context.elderId,
          results
        });
        return {
          memories: authorized.map((memory) => memory.summary),
          items: authorized,
          memoryAvailable: true,
          memorySource: 'mem0'
        };
      } catch (error) {
        logger.warn('memory_get failed', {
          userId: context.userId,
          sessionId: context.sessionId,
          error: (error as Error).message
        });
        return {
          memories: [],
          memoryAvailable: false
        };
      }
    }
  };

  const contextPacketGet: AgentToolDefinition = {
    name: 'context_packet_get',
    description:
      'Retrieve the compact ranked memory/context packet for this turn. Use before assistant-initiated greetings, proactive topics, routine check-ins, missed reminder follow-ups, or gently mentioning pending context cards. Do not use to answer a direct user request when the current conversation already has enough information. Handle mustHandle items first and mention at most one mayMention item in a spoken turn.',
    parameters: z.object({
      triggerType: conversationTriggerSchema.nullish(),
      includeDebug: z.boolean().nullish()
    }),
    timeoutMs: 900,
    execute: async (input, context) => {
      const packet = await deps.elderContextService.getContextPacket({
        userId: context.userId,
        elderId: context.elderId,
        sessionId: context.sessionId,
        triggerType: input.triggerType ?? 'session_start',
        includeDebug: input.includeDebug
      });
      if (!('ok' in packet) || packet.ok !== true) return packet;

      try {
        const results = await deps.mem0.searchScopedMemories({
          userId: context.userId,
          elderId: context.elderId,
          query: contextMemoryQuery(input.triggerType),
          limit: 8,
          timeoutMs: env.MEM0_CONTEXT_SEARCH_TIMEOUT_MS
        });
        const authorized = await deps.elderContextService.authorizeMem0SearchResults({
          userId: context.userId,
          elderId: context.elderId,
          results
        });
        if (authorized.length === 0) return packet;
        return {
          ...packet,
          memories: authorized.slice(0, 6).map((memory) => ({
            memoryId: memory.registryId,
            type: memory.memoryType,
            subject: memory.subject,
            summary: memory.summary,
            confidence: memory.confidence
          }))
        };
      } catch (error) {
        logger.warn('context_packet_get mem0 enrichment unavailable', {
          userId: context.userId,
          sessionId: context.sessionId,
          error: (error as Error).message
        });
        return packet;
      }
    }
  };

  const contextMemoryAdd: AgentToolDefinition = {
    name: 'context_memory_add',
    description:
      "Silently save durable personal context the user reveals in passing. This is a background capture tool: call it even when the user did not ask you to remember anything, and continue the spoken conversation naturally without announcing the save. Decision rule: if the user reveals a durable preference, routine, identity detail, relationship, habit, belief, or meaningful interest without explicitly asking you to remember it, call this tool before or alongside your normal reply. Examples that should call this tool: 'mujhe Krishnamurti ki talks roz sunna achcha lagta hai', 'main har subah mandir jata hoon', 'meri beti Bangalore mein rehti hai', 'mujhe chai bina chini pasand hai'. Never call this when the user says 'yaad rakhna', 'remember this', 'note kar lo', 'save this', or otherwise explicitly asks you to remember; use memory_add instead. Do not call for one-off statements with no personal weight. Do not call for plans or artifacts (use mem0_memory_add instead).",
    parameters: z.object({
      memoryType: memoryTypeSchema,
      subject: z.string(),
      summary: z.string(),
      importance: z.number().int().min(0).max(100).optional(),
      confidence: z.number().int().min(0).max(100).optional(),
      visibility: z.enum(['private', 'caregiver_visible', 'internal_only']).optional(),
      metadata: z.record(z.unknown()).optional()
    }),
    timeoutMs: 6000,
    execute: async (input, context) => {
      const mem0UserId = mem0UserIdFor(context.userId, context.elderId);
      const visibility =
        input.visibility ??
        (input.memoryType === 'health_context' || input.memoryType === 'routine' ? 'caregiver_visible' : 'private');
      const registry = await deps.elderContextService.addMemoryItem({
        userId: context.userId,
        elderId: context.elderId,
        memoryType: input.memoryType as MemoryType,
        subject: input.subject,
        importance: input.importance,
        confidence: input.confidence,
        sourceType: 'assistant_inference',
        visibility,
        mem0UserId,
        mem0Status: 'pending',
        contentHash: contentHash(input.summary),
        metadata: {
          ...(input.metadata ?? {}),
          contentSource: 'mem0',
          captureMode: 'passive'
        }
      });
      if (!registry.ok) return registry;
      if (registry.existing) {
        return {
          ok: true,
          memoryId: registry.memoryId,
          mem0UserId,
          deduped: true
        };
      }

      try {
        const mem0 = await deps.mem0.addScopedMemory({
          userId: context.userId,
          elderId: context.elderId,
          messages: [{ role: 'user', content: input.summary }],
          metadata: {
            registryId: registry.memoryId,
            memoryType: input.memoryType,
            subject: input.subject,
            visibility,
            importance: input.importance ?? 60,
            confidence: input.confidence ?? 72,
            sourceType: 'assistant_inference',
            ...(input.metadata ?? {})
          },
          customInstructions: MITR_MEM0_CUSTOM_INSTRUCTIONS
        });
        await deps.elderContextService.updateMemoryMem0State({
          userId: context.userId,
          elderId: context.elderId,
          memoryId: registry.memoryId,
          mem0EventId: mem0.eventId,
          mem0Status: mem0.status === 'FAILED' ? 'failed' : 'pending'
        });
        return {
          ok: mem0.status !== 'FAILED',
          memoryId: registry.memoryId,
          mem0UserId,
          mem0EventId: mem0.eventId,
          mem0Status: mem0.status
        };
      } catch (error) {
        await deps.elderContextService.updateMemoryMem0State({
          userId: context.userId,
          elderId: context.elderId,
          memoryId: registry.memoryId,
          mem0Status: 'failed',
          error: (error as Error).message
        });
        return {
          ok: false,
          memoryId: registry.memoryId,
          error: 'Mem0 memory write failed; memory content was not stored.',
          mem0Error: (error as Error).message
        };
      }
    }
  };

  const contextCardUpsert: AgentToolDefinition = {
    name: 'context_card_upsert',
    description:
      'Create or refresh a future conversational open loop such as a doctor visit follow-up tomorrow, a pending family callback, or a routine check-in. Use only for specific future context that should be remembered and surfaced later, not for casual chat or general preferences. Set a stable dedupeKey when the same open loop may be refreshed.',
    parameters: z.object({
      cardType: contextCardTypeSchema,
      dedupeKey: optionalStringArg(),
      title: z.string(),
      summary: z.string(),
      priority: z.number().int().min(0).max(100).optional(),
      mentionPolicy: mentionPolicySchema.optional(),
      dueAtISO: optionalStringArg(),
      expiresAtISO: optionalStringArg(),
      maxMentions: z.number().int().min(1).max(10).optional(),
      metadata: z.record(z.unknown()).optional()
    }),
    timeoutMs: 900,
    execute: async (input, context) =>
      deps.elderContextService.upsertContextCard({
        userId: context.userId,
        elderId: context.elderId,
        cardType: input.cardType as ContextCardType,
        dedupeKey: input.dedupeKey,
        title: input.title,
        summary: input.summary,
        priority: input.priority,
        mentionPolicy: input.mentionPolicy as MentionPolicy | undefined,
        dueAt: parseOptionalDate(input.dueAtISO),
        expiresAt: parseOptionalDate(input.expiresAtISO),
        maxMentions: input.maxMentions,
        metadata: input.metadata
      })
  };

  const contextCardOutcomeRecord: AgentToolDefinition = {
    name: 'context_card_outcome_record',
    description:
      "Record what happened after a context card was mentioned so Mitr does not repeat it awkwardly. Call with eventType='mentioned' when you bring up the card, then call again after the user responds with completed, dismissed, ignored, snoozed, answered, or another matching outcome. Do not announce this recording to the user.",
    parameters: z.object({
      cardId: optionalStringArg(),
      dedupeKey: optionalStringArg(),
      eventType: contextCardEventSchema,
      responseState: z.enum(['accepted', 'refused', 'ignored', 'unclear', 'completed']).nullish(),
      notes: optionalStringArg(),
      cooldownMinutes: z.number().int().min(1).max(1440).nullish(),
      metadata: z.record(z.unknown()).optional()
    }),
    timeoutMs: 900,
    execute: async (input, context) =>
      deps.elderContextService.recordCardOutcome({
        userId: context.userId,
        elderId: context.elderId,
        sessionId: context.sessionId,
        cardId: input.cardId,
        dedupeKey: input.dedupeKey,
        eventType: input.eventType as ContextCardEventType,
        responseState: input.responseState,
        notes: input.notes,
        cooldownMinutes: input.cooldownMinutes,
        metadata: input.metadata
      })
  };

  const reminderCreate: AgentToolDefinition = {
    name: 'reminder_create',
    description:
      'Create a schedule reminder or alarm only when the user asks to be reminded about medicine, appointments, routines, calls, or time-bound tasks. Ask a short clarification if the time/date is missing or ambiguous. Do not use for family nudges/messages or for silently inferred follow-ups.',
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
    description:
      'List schedule/alarm reminders known for the current user. Use when the user asks what reminders they have, whether a reminder exists, or wants to manage reminders. Not for retrieving family messages or context cards.',
    parameters: z.object({}),
    timeoutMs: 1000,
    execute: async (_input, context) => {
      const reminders = await deps.reminderService.listByUser(context.userId);
      return { reminders };
    }
  };

  const nudgePendingGet: AgentToolDefinition = {
    name: 'nudge_pending_get',
    description:
      'Get unheard family nudges/messages for the user in playback order: urgent, important, gentle, then queue order. Use before handling family nudges or starting deeper proactive usage, not during ordinary chat. Handle one nudge at a time and use the returned nudgeId/nudgeShortId/nudgeOrdinal for follow-up calls.',
    parameters: z.object({}),
    timeoutMs: 3000,
    execute: async (_input, context) => {
      const pending = await deps.nudgesService.getPendingForElder(context.userId);
      if (!pending) {
        return { hasPending: false };
      }

      const urgentCount = pending.nudges.filter((nudge) => nudge.priority === 'urgent').length;
      const importantCount = pending.nudges.filter((nudge) => nudge.priority === 'important').length;
      const gentleCount = pending.nudges.filter((nudge) => nudge.priority === 'gentle').length;

      return {
        hasPending: true,
        pendingCount: pending.pendingCount,
        nudges: pending.nudges,
        firstNudge: pending.nudges[0],
        priorityCounts: {
          urgent: urgentCount,
          important: importantCount,
          gentle: gentleCount
        }
      };
    }
  };

  const nudgeMarkListened: AgentToolDefinition = {
    name: 'nudge_mark_listened',
    description:
      'Mark only the family nudge(s) just played or read as listened. Use the ID, short ID, or ordinal returned by nudge_pending_get; omit args only when you intentionally want the first pending nudge auto-selected. For voice nudges, respect returned playback fields and do not mark unrelated pending nudges.',
    parameters: z.object({
      nudgeId: z.preprocess((value) => (value == null ? undefined : value), z.string().optional()),
      nudgeIds: z.preprocess(
        (value) => {
          if (value == null) return undefined;
          if (Array.isArray(value)) return value;
          if (typeof value === 'string') return [value];
          return undefined;
        },
        z.array(z.string()).min(1).max(20).optional()
      ),
      nudgeShortId: z.preprocess((value) => (value == null ? undefined : value), z.string().optional()),
      nudgeShortIds: z.preprocess(
        (value) => {
          if (value == null) return undefined;
          if (Array.isArray(value)) return value;
          if (typeof value === 'string') return [value];
          return undefined;
        },
        z.array(z.string()).min(1).max(20).optional()
      ),
      nudgeOrdinal: z.preprocess(
        (value) => (value == null || value === '' ? undefined : value),
        z.coerce.number().int().min(1).max(100).optional()
      )
    }),
    timeoutMs: 3000,
    execute: async (input, context) => {
      const pendingSnapshot = await deps.nudgesService.getPendingForElder(context.userId, 100);
      const pendingNudges = pendingSnapshot?.nudges ?? [];
      const byShortId = new Map<string, string>();
      const orderedIds: string[] = [];
      const pendingById = new Map<string, (typeof pendingNudges)[number]>();
      for (const nudge of pendingNudges) {
        byShortId.set(nudge.nudgeShortId.toLowerCase(), nudge.nudgeId);
        orderedIds.push(nudge.nudgeId);
        pendingById.set(nudge.nudgeId, nudge);
      }

      const rawIds = [
        ...(input.nudgeIds ?? []),
        ...(input.nudgeId ? [input.nudgeId] : [])
      ];
      const rawShortIds = [
        ...(input.nudgeShortIds ?? []),
        ...(input.nudgeShortId ? [input.nudgeShortId] : [])
      ];

      const ids: string[] = [];
      for (const id of rawIds) {
        const normalized = String(id).trim();
        if (normalized.length > 0) ids.push(normalized);
      }
      for (const shortId of rawShortIds) {
        const normalized = String(shortId).trim().toLowerCase();
        if (!normalized) continue;
        const mapped = byShortId.get(normalized);
        if (mapped) ids.push(mapped);
      }
      if (input.nudgeOrdinal && orderedIds.length >= input.nudgeOrdinal) {
        ids.push(orderedIds[input.nudgeOrdinal - 1]);
      }

      const dedupedIds = [...new Set(ids)];
      const resolvedIds =
        dedupedIds.length > 0
          ? dedupedIds
          : orderedIds.length > 0
            ? [orderedIds[0]]
            : [];
      if (resolvedIds.length === 0) {
        return { ok: false, error: 'No pending nudges found to acknowledge.' };
      }

      const selectedNudges = resolvedIds
        .map((id) => pendingById.get(id))
        .filter((item): item is NonNullable<typeof item> => item !== undefined);
      if (selectedNudges.length === 0) {
        return { ok: false, error: 'Nudge not found or already handled.' };
      }

      const selectedTextIds = selectedNudges.filter((item) => item.type !== 'voice').map((item) => item.nudgeId);
      const selectedVoice = selectedNudges.filter((item) => item.type === 'voice');
      const acknowledgedText =
        selectedTextIds.length > 0 ? await deps.nudgesService.markListened(context.userId, selectedTextIds) : [];

      for (const item of selectedVoice) {
        context.publishClientEvent?.({
          type: 'nudge_playback_requested',
          sourceTool: 'nudge_mark_listened',
          requestId: item.nudgeId,
          payload: item
        });
      }

      const selectedSet = new Set(selectedNudges.map((item) => item.nudgeId));
      const nextNudge = (pendingSnapshot?.nudges ?? []).find((item) => !selectedSet.has(item.nudgeId)) ?? null;
      const remainingCount = Math.max((pendingSnapshot?.pendingCount ?? selectedNudges.length) - selectedNudges.length, 0);

      return {
        ok: true,
        nudges: [
          ...acknowledgedText,
          ...selectedVoice.map((item) => ({
            ...item,
            pendingVoiceAck: true
          }))
        ],
        playedCount: selectedNudges.length,
        voiceQueuedCount: selectedVoice.length,
        textAcknowledgedCount: acknowledgedText.length,
        autoSelectedFirstPending: dedupedIds.length === 0,
        remainingCount,
        nextNudge
      };
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
      'Retrieve current-affairs news before answering any latest, current, today, headlines, or taaza khabar request. Write the query in plain language from the user intent; for generic news use an India-wide query such as "top news in India today" with freshness=latest. Do not default to local news unless the user asks for local/regional news or names a place; if local news is requested without a place, ask one short clarification question before calling. For multi-part questions, make multiple focused calls if needed. If result is pending, acknowledge briefly and wait for follow-up data; do not ask unrelated "anything else" prompts. When ready, summarize only from tool output with headline, source, why it matters, and one concrete detail; collapse duplicate coverage of the same story.',
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
        numResults: Math.max(input.numResults ?? MIN_NEWS_RESULTS, MIN_NEWS_RESULTS),
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

  const webSearch: AgentToolDefinition = {
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
    execute: async (input, context) => {
      const normalizedInput = {
        query: input.query.trim(),
        numResults: input.numResults ?? undefined,
        recencyDays: input.recencyDays ?? undefined,
        language: input.language ?? context.language,
        regionCode: input.regionCode ?? undefined,
        includeDomains: input.includeDomains ?? undefined,
        searchType: input.searchType ?? undefined
      };

      const key = JSON.stringify(normalizedInput);
      const now = Date.now();
      for (const [jobKey, job] of webSearchJobsByKey.entries()) {
        if (now - job.updatedAt > NEWS_JOB_TTL_MS) webSearchJobsByKey.delete(jobKey);
      }

      const existing = webSearchJobsByKey.get(key);
      if (existing && existing.status === 'ready' && existing.result) {
        return {
          status: 'ready',
          requestId: existing.requestId,
          query: normalizedInput.query,
          items: existing.result.items
        };
      }
      if (existing && existing.status === 'pending') {
        return {
          status: 'pending',
          requestId: existing.requestId,
          query: normalizedInput.query,
          message: 'Searching the web in background.'
        };
      }

      const requestId = nextRequestId('web');
      webSearchJobsByKey.set(key, {
        requestId,
        status: 'pending',
        updatedAt: now
      });

      void deps.webSearchService
        .search(normalizedInput.query, {
          numResults: normalizedInput.numResults,
          recencyDays: normalizedInput.recencyDays,
          language: normalizedInput.language,
          regionCode: normalizedInput.regionCode,
          includeDomains: normalizedInput.includeDomains,
          searchType: normalizedInput.searchType
        })
        .then((items) => {
          webSearchJobsByKey.set(key, {
            requestId,
            status: 'ready',
            updatedAt: Date.now(),
            result: { items }
          });
          context.publishClientEvent?.({
            type: 'web_search_ready',
            sourceTool: 'web_search',
            requestId,
            payload: {
              query: normalizedInput.query,
              itemCount: items.length,
              recencyDays: normalizedInput.recencyDays,
              includeDomains: normalizedInput.includeDomains,
              items
            }
          });
        })
        .catch((error) => {
          const message = (error as Error).message || 'Unknown web search error';
          webSearchJobsByKey.set(key, {
            requestId,
            status: 'failed',
            updatedAt: Date.now(),
            error: message
          });
          context.publishClientEvent?.({
            type: 'web_search_failed',
            sourceTool: 'web_search',
            requestId,
            payload: {
              query: normalizedInput.query,
              error: message
            }
          });
        });

      return {
        status: 'pending',
        requestId,
        query: normalizedInput.query,
        message: 'Searching the web in background.'
      };
    }
  };

  const panchangGet: AgentToolDefinition = {
    name: 'panchang_get',
    description:
      'Get grounded Panchang for India by city. Confirm city each session before call. Supports queryType: today_snapshot, next_tithi, upcoming_tithi_dates, tithi_on_date. Festival date questions must use this tool. If response is needs_city/needs_confirmation, ask concise follow-up.',
    parameters: z.object({
      city: optionalStringArg(),
      stateOrRegion: optionalStringArg(),
      countryCode: optionalStringArg(),
      dateISO: optionalStringArg(),
      queryType: z.enum(['today_snapshot', 'next_tithi', 'upcoming_tithi_dates', 'tithi_on_date']).optional(),
      tithiName: optionalStringArg(),
      occurrenceCount: z.number().int().min(1).max(5).optional(),
      lookaheadDays: z.number().int().min(7).max(180).optional(),
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

      const lastUserText = context.getLastUserTranscript?.() ?? '';
      const mentionsToday = /(आज|aaj|today|tdy)/i.test(lastUserText);
      const mentionsExplicitDate = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?/i.test(lastUserText);
      const sanitizedDateISO = mentionsToday && !mentionsExplicitDate ? undefined : (input.dateISO ?? undefined);
      const festivalHint = detectFestivalHint(lastUserText);
      const resolvedTithiKey =
        resolveTithiKey(input.tithiName) ?? festivalHint?.tithiKey ?? extractTithiKeyFromText(lastUserText);
      const queryType = inferPanchangQueryType(input.queryType, lastUserText, resolvedTithiKey, festivalHint?.key);
      const occurrenceCount = clampInt(input.occurrenceCount ?? (queryType === 'upcoming_tithi_dates' ? 3 : 1), 1, 5);
      const lookaheadDefault = festivalHint?.lookaheadDays ?? (queryType === 'upcoming_tithi_dates' ? 120 : 45);
      const lookaheadDays = clampInt(input.lookaheadDays ?? lookaheadDefault, 7, 365);
      const monthFilter = festivalHint?.monthFilter;

      const normalizedInput = {
        city,
        stateOrRegion: input.stateOrRegion ?? undefined,
        countryCode: 'IN',
        dateISO: sanitizedDateISO,
        queryType,
        tithiKey: resolvedTithiKey,
        festivalKey: festivalHint?.key,
        monthFilter,
        occurrenceCount,
        lookaheadDays,
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
          queryType: normalizedInput.queryType,
          tithiKey: normalizedInput.tithiKey,
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
        .then(async (todayResult) => {
          let result: Record<string, unknown> = todayResult;

          if (normalizedInput.queryType === 'next_tithi' || normalizedInput.queryType === 'upcoming_tithi_dates') {
              if (!normalizedInput.tithiKey) {
                result = {
                  status: 'needs_tithi',
                  queryType: normalizedInput.queryType,
                  message: 'Please specify which tithi to search for, for example Ashtami or Ekadashi.'
                };
              } else if ((todayResult.status as string) !== 'ready') {
                result = {
                  ...todayResult,
                  queryType: normalizedInput.queryType,
                  targetTithi: normalizedInput.tithiKey,
                  festivalKey: normalizedInput.festivalKey
                };
              } else {
                const matches: Array<Record<string, unknown>> = [];
                const todayLocation = asRecord(todayResult.location);
                const baseLatitude = asNumber(todayLocation?.latitude);
                const baseLongitude = asNumber(todayLocation?.longitude);
                const canReuseCoordinates =
                  typeof baseLatitude === 'number' &&
                  typeof baseLongitude === 'number' &&
                  Number.isFinite(baseLatitude) &&
                  Number.isFinite(baseLongitude);
                const startOffset = computeSearchStartOffset(
                  normalizedInput.dateISO,
                  normalizedInput.monthFilter,
                  normalizedInput.lookaheadDays
                );
                for (let dayOffset = startOffset; dayOffset <= normalizedInput.lookaheadDays; dayOffset += 1) {
                  const candidateDate = addDaysIst(normalizedInput.dateISO, dayOffset);
                  const candidate = canReuseCoordinates
                    ? await deps.panchangService.getByCoordinates({
                        inputCity: normalizedInput.city,
                        city: typeof todayLocation?.city === 'string' ? todayLocation.city : normalizedInput.city,
                        state: typeof todayLocation?.state === 'string' ? todayLocation.state : normalizedInput.stateOrRegion,
                        district: typeof todayLocation?.district === 'string' ? todayLocation.district : undefined,
                        country: typeof todayLocation?.country === 'string' ? todayLocation.country : 'India',
                        countryCode: 'IN',
                        timezone: typeof todayLocation?.timezone === 'string' ? todayLocation.timezone : INDIA_TIMEZONE,
                        latitude: baseLatitude as number,
                        longitude: baseLongitude as number,
                        dateISO: candidateDate,
                        language: normalizedInput.language,
                        ayanamsa: normalizedInput.ayanamsa
                      })
                    : await deps.panchangService.getByCity({
                        city: normalizedInput.city,
                        stateOrRegion: normalizedInput.stateOrRegion,
                        countryCode: 'IN',
                        dateISO: candidateDate,
                        language: normalizedInput.language,
                        ayanamsa: normalizedInput.ayanamsa,
                        locationConfirmed: true
                      });
                  if ((candidate.status as string) !== 'ready') continue;
                  const tithi = readCurrentTithi(candidate);
                  if (!matchesTithi(tithi.name, normalizedInput.tithiKey)) continue;
                  const candidateMonth = Number(candidateDate.slice(5, 7));
                  if (normalizedInput.monthFilter && normalizedInput.monthFilter.length > 0) {
                    if (!normalizedInput.monthFilter.includes(candidateMonth)) continue;
                  }
                  const location = asRecord(candidate.location);
                  matches.push({
                    dateISO: candidateDate,
                    city: typeof location?.city === 'string' ? location.city : normalizedInput.city,
                    state: typeof location?.state === 'string' ? location.state : normalizedInput.stateOrRegion,
                  tithi
                });
                if (matches.length >= normalizedInput.occurrenceCount) break;
              }

              if (matches.length === 0) {
                result = {
                  status: 'not_found_within_window',
                  queryType: normalizedInput.queryType,
                  targetTithi: normalizedInput.tithiKey,
                  festivalKey: normalizedInput.festivalKey,
                  monthFilter: normalizedInput.monthFilter,
                  lookaheadDays: normalizedInput.lookaheadDays,
                  message: `No ${normalizedInput.tithiKey} found in next ${normalizedInput.lookaheadDays} days for ${normalizedInput.city}.`
                };
              } else {
                result = {
                  status: 'ready',
                  queryType: normalizedInput.queryType,
                  targetTithi: normalizedInput.tithiKey,
                  festivalKey: normalizedInput.festivalKey,
                  monthFilter: normalizedInput.monthFilter,
                  lookaheadDays: normalizedInput.lookaheadDays,
                  occurrenceCount: normalizedInput.occurrenceCount,
                  nextMatch: matches[0],
                  matches
                };
              }
            }
          } else if (normalizedInput.queryType === 'tithi_on_date') {
            result = {
              ...todayResult,
              queryType: normalizedInput.queryType,
              targetDateISO: normalizedInput.dateISO ?? addDaysIst(undefined, 0)
            };
          } else {
            result = {
              ...todayResult,
              queryType: normalizedInput.queryType
            };
          }

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
              queryType: normalizedInput.queryType,
              tithiKey: normalizedInput.tithiKey,
              festivalKey: normalizedInput.festivalKey,
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
        queryType: normalizedInput.queryType,
        tithiKey: normalizedInput.tithiKey,
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
      'Start/resume structured flow (satsang/story/companion). Returns flow.nextStep; treat nextStep as source of truth for immediate spoken response.',
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
      'Advance active flow and return nextStep to speak now. If nextStep.fixedText exists, recite faithfully first. Use auto=true for hands-free progression in continuous mode.',
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
    description:
      'Get guided breathing steps for calming and emotional support, but only when the user explicitly asks for breathing/relaxation help or clearly agrees after you first respond with empathy. Never use this as the first response to pain, illness, or emotional distress.',
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

  const conversationPlannerGet: AgentToolDefinition = {
    name: 'conversation_planner_get',
    description:
      'Plan the next elder-aware proactive conversation move. Use before proactive greetings, routine check-ins, reminder follow-ups, family bridge prompts, or assistant-initiated questions that were not already determined by context_packet_get. Treat returned promptSeed, allowedQuestionCount, followupPolicy, and constraints as planning guidance, then speak naturally instead of reading it as a script.',
    parameters: z.object({
      triggerType: conversationTriggerSchema.nullish(),
      reminderId: optionalStringArg(),
      reminderTitle: optionalStringArg(),
      routineKey: optionalStringArg(),
      routineTitle: optionalStringArg(),
      recordPrompt: z.boolean().nullish()
    }),
    timeoutMs: 2500,
    execute: async (input, context) =>
      deps.elderJourneyService.getConversationPlan({
        userId: context.userId,
        elderId: context.elderId,
        sessionId: context.sessionId,
        triggerType: (input.triggerType ?? 'session_start') as ConversationTriggerType,
        reminderId: input.reminderId,
        reminderTitle: input.reminderTitle,
        routineKey: input.routineKey,
        routineTitle: input.routineTitle,
        recordPrompt: input.recordPrompt
      })
  };

  const promptOutcomeRecord: AgentToolDefinition = {
    name: 'prompt_outcome_record',
    description:
      "Record the elder's response to a planned proactive prompt. Call after the user responds to a prompt from conversation_planner_get, using the returned promptHistoryId and the closest responseState. Do not call for ordinary user-initiated conversation.",
    parameters: z.object({
      promptHistoryId: optionalStringArg(),
      triggerType: conversationTriggerSchema.nullish(),
      promptType: optionalStringArg(),
      promptKey: optionalStringArg(),
      topic: optionalStringArg(),
      responseState: z.enum(['accepted', 'refused', 'ignored', 'unclear', 'completed']),
      sentiment: z.enum(['positive', 'neutral', 'negative']).nullish(),
      metadata: z.record(z.unknown()).optional()
    }),
    timeoutMs: 1200,
    execute: async (input, context) =>
      deps.elderJourneyService.recordPromptOutcome({
        userId: context.userId,
        elderId: context.elderId,
        promptHistoryId: input.promptHistoryId,
        triggerType: input.triggerType as ConversationTriggerType | null | undefined,
        promptType: input.promptType,
        promptKey: input.promptKey,
        topic: input.topic,
        responseState: input.responseState as PromptResponseState,
        sentiment: input.sentiment as PromptSentiment | null | undefined,
        metadata: input.metadata
      })
  };

  const medicationResponseRecord: AgentToolDefinition = {
    name: 'medication_response_record',
    description:
      "Record how the elder responded to a medication reminder or medication check-in before continuing the conversation. Decision rule: when the previous assistant turn asked about a medicine/reminder, or the user says they took, skipped, refused, delayed, forgot, or are unsure about a medicine dose, call this tool even if reminderId is unavailable. Examples that should call this tool: 'haan, maine BP ki dawai le li', 'abhi nahi li, thodi der mein lunga', 'aaj skip kar di', 'pata nahi li thi ya nahi'. Use status=taken, delayed, refused, no_response, or unclear based on what the user said. Keep responseText short and factual. Do not diagnose or add medical interpretation.",
    parameters: z.object({
      reminderId: optionalStringArg(),
      medicine: optionalStringArg(),
      scheduledAt: optionalStringArg(),
      status: z.enum(['taken', 'delayed', 'refused', 'no_response', 'unclear']),
      responseText: optionalStringArg(),
      metadata: z.record(z.unknown()).optional()
    }),
    timeoutMs: 1800,
    execute: async (input, context) =>
      deps.elderJourneyService.recordMedicationResponse({
        userId: context.userId,
        elderId: context.elderId,
        reminderId: input.reminderId,
        medicine: input.medicine,
        scheduledAt: input.scheduledAt,
        status: input.status,
        responseText: input.responseText,
        metadata: input.metadata
      })
  };

  const medicationAdherenceSetup: AgentToolDefinition = {
    name: 'medication_adherence_setup',
    description:
      'Capture a medication adherence setup request when the user wants recurring medicine reminders or medication tracking configured. Use only for setup or configuration intent, not for recording a single reminder response; use medication_response_record for that. This creates the base medication reminder plus follow-up reminders.',
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
    memoryAdd,
    recaSkillGet,
    mem0MemoryAdd,
    mem0MemorySearch,
    mem0MemoryList,
    mem0MemoryGet,
    mem0MemoryUpdate,
    mem0MemoryDelete,
    memoryGet,
    contextPacketGet,
    contextMemoryAdd,
    contextCardUpsert,
    contextCardOutcomeRecord,
    reminderCreate,
    reminderList,
    nudgePendingGet,
    nudgeMarkListened,
    devotionalPlaylistGet,
    dailyBriefingGet,
    diaryAdd,
    diaryList,
    flowStart,
    flowNext,
    flowStop,
    pranayamaGuideGet,
    brainGameGet,
    festivalContextGet,
    conversationPlannerGet,
    promptOutcomeRecord,
    medicationResponseRecord,
    medicationAdherenceSetup
  ];

  if (includeAsyncTools) {
    definitions.unshift(religiousRetrieve, storyRetrieve);
    definitions.splice(8, 0, newsRetrieve, webSearch, panchangGet, youtubeMediaGet);
  }

  if (logRegistration) {
    logger.info('Agent tools registered', {
      tools: definitions.map((tool) => tool.name)
    });
  }

  return definitions;
};
