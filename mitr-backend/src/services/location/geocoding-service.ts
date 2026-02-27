import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

interface OpenMeteoGeocodeResult {
  name?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  country?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  population?: number;
}

interface OpenMeteoGeocodeResponse {
  results?: OpenMeteoGeocodeResult[];
}

export type GeocodingCandidate = {
  name: string;
  admin1?: string;
  admin2?: string;
  country?: string;
  countryCode?: string;
  timezone?: string;
  latitude: number;
  longitude: number;
  confidence: 'high' | 'medium' | 'low';
  score: number;
};

export type ResolveCityResult = {
  primary: GeocodingCandidate | null;
  candidates: GeocodingCandidate[];
};

const normalize = (value?: string): string =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const scoreCandidate = (
  candidate: OpenMeteoGeocodeResult,
  query: { city: string; stateOrRegion?: string; countryCode?: string }
): number => {
  const cityNorm = normalize(query.city);
  const stateNorm = normalize(query.stateOrRegion);
  const countryNorm = normalize(query.countryCode);
  const nameNorm = normalize(candidate.name);
  const adminNorm = normalize(candidate.admin1);
  const candidateCountryCode = normalize(candidate.country_code);
  let score = 0;

  if (nameNorm === cityNorm) score += 50;
  else if (nameNorm.startsWith(cityNorm) || cityNorm.startsWith(nameNorm)) score += 30;
  else if (nameNorm.includes(cityNorm) || cityNorm.includes(nameNorm)) score += 20;

  if (stateNorm && adminNorm) {
    if (adminNorm === stateNorm) score += 18;
    else if (adminNorm.includes(stateNorm) || stateNorm.includes(adminNorm)) score += 10;
  }

  if (countryNorm && candidateCountryCode) {
    if (countryNorm === candidateCountryCode) score += 16;
  }

  const population = typeof candidate.population === 'number' ? Math.max(candidate.population, 0) : 0;
  if (population > 0) {
    score += Math.min(22, Math.log10(population + 1) * 4);
  }

  return score;
};

const toConfidence = (score: number, gapToSecond: number): 'high' | 'medium' | 'low' => {
  if (score >= 68 && gapToSecond >= 8) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
};

export class GeocodingService {
  private async fetchCandidates(query: string, countryCode: string, count: number): Promise<OpenMeteoGeocodeResult[]> {
    const url = new URL(`${env.GEOCODING_BASE_URL}/search`);
    url.searchParams.set('name', query);
    url.searchParams.set('count', String(count));
    url.searchParams.set('countryCode', countryCode);
    url.searchParams.set('language', 'en');
    url.searchParams.set('format', 'json');

    const timeoutMs = Math.max(env.GEOCODING_TIMEOUT_MS, 7000);
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url.toString(), { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Geocoding failed with status ${response.status}`);
        }

        const payload = (await response.json()) as OpenMeteoGeocodeResponse;
        return Array.isArray(payload.results) ? payload.results : [];
      } catch (error) {
        lastError = error as Error;
        const message = (error as Error)?.message ?? 'unknown geocoding error';
        const isAbort = message.toLowerCase().includes('aborted');
        if (!isAbort || attempt === 2) break;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new Error('Geocoding request failed');
  }

  async resolveCity(input: {
    city: string;
    stateOrRegion?: string;
    countryCode?: string;
    maxCandidates?: number;
  }): Promise<ResolveCityResult> {
    const city = input.city.trim();
    if (!city) return { primary: null, candidates: [] };

    const countryCode = (input.countryCode ?? env.GEOCODING_DEFAULT_COUNTRY ?? 'IN').trim().toUpperCase();
    const count = Math.min(Math.max(input.maxCandidates ?? 5, 1), 10);
    const queryWithRegion = [city, input.stateOrRegion ?? ''].filter(Boolean).join(' ').trim();
    const queryCityOnly = city;

    try {
      let rawResults = await this.fetchCandidates(queryWithRegion, countryCode, count);
      if (rawResults.length === 0 && queryWithRegion !== queryCityOnly) {
        rawResults = await this.fetchCandidates(queryCityOnly, countryCode, count);
      }
      const ranked = rawResults
        .filter(
          (item) =>
            typeof item.latitude === 'number' &&
            typeof item.longitude === 'number' &&
            typeof item.name === 'string' &&
            item.name.trim().length > 0
        )
        .map((item) => ({
          item,
          score: scoreCandidate(item, {
            city,
            stateOrRegion: input.stateOrRegion,
            countryCode
          })
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, count);

      const secondScore = ranked[1]?.score ?? 0;
      const candidates: GeocodingCandidate[] = ranked.map(({ item, score }) => ({
        name: item.name as string,
        admin1: item.admin1,
        admin2: item.admin2,
        country: item.country,
        countryCode: item.country_code,
        timezone: item.timezone,
        latitude: item.latitude as number,
        longitude: item.longitude as number,
        score,
        confidence: toConfidence(score, score - secondScore)
      }));

      logger.info('Geocoding resolveCity', {
        city,
        stateOrRegion: input.stateOrRegion ?? null,
        countryCode,
        candidates: candidates.map((c) => ({
          name: c.name,
          admin1: c.admin1,
          countryCode: c.countryCode,
          confidence: c.confidence,
          score: c.score
        }))
      });

      return {
        primary: candidates[0] ?? null,
        candidates
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.warn('Geocoding resolveCity failed', {
        city,
        stateOrRegion: input.stateOrRegion ?? null,
        countryCode,
        error: message
      });
      return { primary: null, candidates: [] };
    }
  }
}
