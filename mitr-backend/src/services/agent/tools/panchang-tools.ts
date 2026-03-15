import { z } from 'zod';
import { AsyncToolRuntime } from '../../../agent-worker/async-tool-runtime.js';
import type { AgentToolDefinition, AgentToolContext, ToolDeps } from './legacy-tools.js';

const optionalStringArg = () =>
  z.preprocess((value) => (value == null ? undefined : value), z.string().optional());

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

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value), min), max);

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
  const base =
    baseDateISO && /^\d{4}-\d{2}-\d{2}$/.test(baseDateISO)
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
  const base =
    baseDateISO && /^\d{4}-\d{2}-\d{2}$/.test(baseDateISO)
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

export const createPanchangTool = (
  deps: ToolDeps,
  runtime: AsyncToolRuntime
): AgentToolDefinition => ({
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
  execute: async (input, context: AgentToolContext) => {
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

    const key = `${context.sessionId}:${JSON.stringify(normalizedInput)}`;

    return runtime.start({
      tool: 'panchang_get',
      key,
      requestIdPrefix: 'panchang',
      context,
      ttlMs: 2 * 60 * 1000,
      legacyReadyType: 'panchang_get_ready',
      legacyFailedType: 'panchang_get_failed',
      pendingResponse: (requestId) => ({
        status: 'pending',
        requestId,
        city: normalizedInput.city,
        stateOrRegion: normalizedInput.stateOrRegion,
        countryCode: normalizedInput.countryCode,
        queryType: normalizedInput.queryType,
        tithiKey: normalizedInput.tithiKey,
        message: 'Fetching Panchang in background.'
      }),
      execute: async () => {
        const todayResult = await deps.panchangService.getByCity(normalizedInput);
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
                    state:
                      typeof todayLocation?.state === 'string' ? todayLocation.state : normalizedInput.stateOrRegion,
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

        return result;
      },
      onReady: (requestId, result) => ({
        response: {
          status: 'ready',
          requestId,
          ...result
        },
        payload: {
          city: normalizedInput.city,
          stateOrRegion: normalizedInput.stateOrRegion,
          countryCode: normalizedInput.countryCode,
          queryType: normalizedInput.queryType,
          tithiKey: normalizedInput.tithiKey,
          festivalKey: normalizedInput.festivalKey,
          result
        }
      }),
      onFailed: (_requestId, error) => ({
        payload: {
          city: normalizedInput.city,
          stateOrRegion: normalizedInput.stateOrRegion,
          countryCode: normalizedInput.countryCode,
          error
        }
      })
    });
  }
});
