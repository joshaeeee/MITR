import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { GeocodingService, type GeocodingCandidate } from '../location/geocoding-service.js';

type PanchangLanguage = 'en' | 'hi' | 'ta' | 'te' | 'ml';

type ProkeralaTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
};

type ProkeralaPanchangResponse = {
  status?: string;
  data?: Record<string, unknown>;
};

type PanchangPeriod = {
  name: string;
  type?: string;
  period: Array<{
    start: string;
    end: string;
  }>;
};

const mapLanguage = (language?: string): PanchangLanguage => {
  const value = (language ?? '').toLowerCase();
  if (value.startsWith('hi')) return 'hi';
  if (value.startsWith('ta')) return 'ta';
  if (value.startsWith('te')) return 'te';
  if (value.startsWith('ml')) return 'ml';
  return 'en';
};

const asArray = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const firstEntry = (value: unknown): Record<string, unknown> | undefined => asArray(value)[0];

const withDefaultDateTime = (dateISO: string | undefined): string => {
  if (dateISO && !Number.isNaN(Date.parse(dateISO))) return new Date(dateISO).toISOString();
  return new Date().toISOString();
};

export class PanchangService {
  private tokenCache: {
    token: string;
    expiresAtMs: number;
  } | null = null;

  constructor(private readonly geocodingService: GeocodingService) {}

  private async getAccessToken(): Promise<string> {
    if (!env.PROKERALA_CLIENT_ID || !env.PROKERALA_CLIENT_SECRET) {
      throw new Error('Panchang provider credentials missing: PROKERALA_CLIENT_ID / PROKERALA_CLIENT_SECRET');
    }

    if (this.tokenCache && this.tokenCache.expiresAtMs > Date.now() + 15_000) {
      return this.tokenCache.token;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.PROKERALA_CLIENT_ID,
      client_secret: env.PROKERALA_CLIENT_SECRET
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.PROKERALA_TIMEOUT_MS);
    try {
      const response = await fetch(env.PROKERALA_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body.toString(),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Token request failed with status ${response.status}`);
      }
      const payload = (await response.json()) as ProkeralaTokenResponse;
      const token = payload.access_token;
      if (!token) throw new Error('Token response missing access_token');
      const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3600;
      this.tokenCache = {
        token,
        expiresAtMs: Date.now() + Math.max(60, expiresIn - 30) * 1000
      };
      return token;
    } finally {
      clearTimeout(timeout);
    }
  }

  private simplifyPeriods(value: unknown): PanchangPeriod[] {
    return asArray(value)
      .map((period) => ({
        name: asString(period.name) ?? 'Unknown',
        type: asString(period.type),
        period: asArray(period.period)
          .map((entry) => ({
            start: asString(entry.start) ?? '',
            end: asString(entry.end) ?? ''
          }))
          .filter((entry) => entry.start || entry.end)
      }))
      .filter((period) => period.period.length > 0);
  }

  async getByCity(input: {
    city: string;
    stateOrRegion?: string;
    countryCode?: string;
    dateISO?: string;
    language?: string;
    ayanamsa?: number;
    locationConfirmed?: boolean;
  }): Promise<Record<string, unknown>> {
    if (!env.PROKERALA_CLIENT_ID || !env.PROKERALA_CLIENT_SECRET) {
      return {
        status: 'unavailable',
        message: 'Panchang provider is not configured yet. Missing PROKERALA_CLIENT_ID/PROKERALA_CLIENT_SECRET.'
      };
    }

    const city = input.city.trim();
    if (!city) {
      return {
        status: 'needs_city',
        message: 'City is required. Please provide city name for Panchang.'
      };
    }

    const resolved = await this.geocodingService.resolveCity({
      city,
      stateOrRegion: input.stateOrRegion,
      countryCode: input.countryCode
    });

    const best = resolved.primary;
    if (!best) {
      return {
        status: 'not_found',
        message: `Could not resolve coordinates for city "${city}". Please share city with state/country.`
      };
    }

    if (best.confidence === 'low' && input.locationConfirmed !== true) {
      return {
        status: 'needs_confirmation',
        message: 'City match is ambiguous. Please confirm the correct location before Panchang.',
        inferredLocation: {
          city: best.name,
          state: best.admin1,
          country: best.country,
          countryCode: best.countryCode
        },
        candidates: resolved.candidates.slice(0, 3).map((candidate: GeocodingCandidate) => ({
          city: candidate.name,
          state: candidate.admin1,
          country: candidate.country,
          countryCode: candidate.countryCode,
          confidence: candidate.confidence
        }))
      };
    }

    const token = await this.getAccessToken();
    const dateTime = withDefaultDateTime(input.dateISO);
    const ayanamsa = [1, 3, 5].includes(input.ayanamsa ?? 1) ? (input.ayanamsa ?? 1) : 1;
    const language = mapLanguage(input.language);

    const url = new URL(`${env.PROKERALA_BASE_URL}/astrology/panchang/advanced`);
    url.searchParams.set('ayanamsa', String(ayanamsa));
    url.searchParams.set('coordinates', `${best.latitude},${best.longitude}`);
    url.searchParams.set('datetime', dateTime);
    url.searchParams.set('la', language);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.PROKERALA_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Panchang request failed with status ${response.status}`);
      }
      const payload = (await response.json()) as ProkeralaPanchangResponse;
      if (payload.status !== 'ok' || !payload.data || typeof payload.data !== 'object') {
        throw new Error('Panchang provider returned unexpected response');
      }
      const data = payload.data;
      const tithi = firstEntry(data.tithi);
      const nakshatra = firstEntry(data.nakshatra);
      const yoga = firstEntry(data.yoga);
      const karana = firstEntry(data.karana);

      const result = {
        status: 'ready',
        location: {
          inputCity: city,
          city: best.name,
          state: best.admin1,
          district: best.admin2,
          country: best.country,
          countryCode: best.countryCode,
          latitude: best.latitude,
          longitude: best.longitude,
          timezone: best.timezone,
          confidence: best.confidence
        },
        datetime: dateTime,
        ayanamsa,
        language,
        panchang: {
          vaara: asString(data.vaara),
          tithi: {
            name: asString(tithi?.name),
            paksha: asString(tithi?.paksha),
            start: asString(tithi?.start),
            end: asString(tithi?.end)
          },
          nakshatra: {
            name: asString(nakshatra?.name),
            start: asString(nakshatra?.start),
            end: asString(nakshatra?.end)
          },
          yoga: {
            name: asString(yoga?.name),
            start: asString(yoga?.start),
            end: asString(yoga?.end)
          },
          karana: {
            name: asString(karana?.name),
            start: asString(karana?.start),
            end: asString(karana?.end)
          },
          sunrise: asString(data.sunrise),
          sunset: asString(data.sunset),
          moonrise: asString(data.moonrise),
          moonset: asString(data.moonset),
          auspiciousPeriods: this.simplifyPeriods(data.auspicious_period),
          inauspiciousPeriods: this.simplifyPeriods(data.inauspicious_period)
        }
      };

      logger.info('Panchang fetch success', {
        city: best.name,
        state: best.admin1 ?? null,
        countryCode: best.countryCode ?? null,
        datetime: dateTime,
        language
      });

      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}
