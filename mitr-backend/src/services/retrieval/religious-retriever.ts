import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { EmbeddingService } from '../embeddings/embedding-service.js';
import { createQdrantClient } from './qdrant-client.js';

export interface ReligiousQuery {
  query: string;
  language?: string;
  tradition?: string;
  depth?: 'short' | 'standard' | 'deep';
}

export interface Citation {
  title: string;
  source: string;
  passage: string;
  tradition?: string;
  language?: string;
}

export interface StoryQuery {
  query: string;
  language?: string;
  tradition?: string;
  region?: string;
  k?: number;
}

export interface StoryHit extends Citation {
  storyId?: string;
  region?: string;
  tone?: string;
  moral?: string;
}

export class ReligiousRetriever {
  private qdrant: QdrantClient;
  private embeddings: EmbeddingService;

  constructor() {
    this.qdrant = createQdrantClient();
    this.embeddings = new EmbeddingService();
  }

  private static normalizeFilterValue(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    const text = String(value).trim();
    return text.length > 0 ? text.toLowerCase() : undefined;
  }

  private static payloadValue(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    if (Array.isArray(value)) {
      const first = value.find((item) => item !== null && item !== undefined);
      return first === undefined ? undefined : String(first);
    }
    if (value === null || value === undefined) return undefined;
    return String(value);
  }

  private static selectStoryRows<T extends { id?: unknown; payload?: Record<string, unknown> | null }>(
    rows: T[],
    input: StoryQuery,
    requestedLimit: number
  ): T[] {
    const expectedLanguage = ReligiousRetriever.normalizeFilterValue(input.language);
    const expectedTradition = ReligiousRetriever.normalizeFilterValue(input.tradition);
    const expectedRegion = ReligiousRetriever.normalizeFilterValue(input.region);

    const matches = (
      payload: Record<string, unknown>,
      expected: {
        language?: string;
        tradition?: string;
        region?: string;
      }
    ): boolean => {
      const payloadKind = ReligiousRetriever.normalizeFilterValue(
        ReligiousRetriever.payloadValue(payload, 'kind')
      );
      const hasStoryId = ReligiousRetriever.payloadValue(payload, 'story_id') !== undefined;
      if (payloadKind !== 'story' && !hasStoryId) return false;

      if (expected.language) {
        const payloadLanguage = ReligiousRetriever.normalizeFilterValue(
          ReligiousRetriever.payloadValue(payload, 'language')
        );
        if (payloadLanguage !== expected.language) return false;
      }
      if (expected.tradition) {
        const payloadTradition = ReligiousRetriever.normalizeFilterValue(
          ReligiousRetriever.payloadValue(payload, 'tradition')
        );
        if (payloadTradition !== expected.tradition) return false;
      }
      if (expected.region) {
        const payloadRegion = ReligiousRetriever.normalizeFilterValue(
          ReligiousRetriever.payloadValue(payload, 'region')
        );
        if (payloadRegion !== expected.region) return false;
      }
      return true;
    };

    const candidates = [
      { language: expectedLanguage, tradition: expectedTradition, region: expectedRegion },
      { language: expectedLanguage, tradition: expectedTradition, region: undefined },
      { language: expectedLanguage, tradition: undefined, region: expectedRegion },
      { language: expectedLanguage, tradition: undefined, region: undefined },
      { language: undefined, tradition: undefined, region: undefined }
    ];

    const selected: T[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      for (const row of rows) {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        if (!matches(payload, candidate)) continue;
        const id = String(row.id ?? '');
        if (seen.has(id)) continue;
        seen.add(id);
        selected.push(row);
        if (selected.length >= requestedLimit) return selected;
      }
    }
    return selected;
  }

  private static isMissingPayloadIndexError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const raw =
      (error as { data?: { status?: { error?: unknown } } }).data?.status?.error ??
      (error as { message?: unknown }).message;
    if (typeof raw !== 'string') return false;
    return /index required but not found/i.test(raw);
  }

  private static errorForLog(error: unknown): unknown {
    if (!error || typeof error !== 'object') return error;
    const apiError = error as {
      status?: number;
      statusText?: string;
      message?: string;
      data?: unknown;
    };
    return {
      status: apiError.status,
      statusText: apiError.statusText,
      message: apiError.message,
      data: apiError.data
    };
  }

  async retrieve(input: ReligiousQuery): Promise<Citation[]> {
    let vector: number[];
    try {
      const [embedded] = await this.embeddings.embed([input.query]);
      vector = embedded;
    } catch (error) {
      logger.warn('Religious retrieval skipped: embedding generation failed', {
        reason: (error as Error).message
      });
      return [];
    }
    const must: Array<Record<string, unknown>> = [];

    if (input.language) must.push({ key: 'language', match: { value: input.language } });
    if (input.tradition) must.push({ key: 'tradition', match: { value: input.tradition } });

    const requestedLimit = input.depth === 'deep' ? 8 : 4;
    let result = await this.qdrant.search(env.QDRANT_COLLECTION, {
      vector,
      limit: requestedLimit,
      filter: must.length ? { must } : undefined,
      with_payload: true
    }).catch(async (error) => {
      if (!must.length || !ReligiousRetriever.isMissingPayloadIndexError(error)) {
        throw error;
      }
      logger.warn('Religious retrieval filter unavailable; falling back to local payload filtering', {
        reason: ReligiousRetriever.errorForLog(error)
      });
      const expanded = await this.qdrant.search(env.QDRANT_COLLECTION, {
        vector,
        limit: Math.max(requestedLimit * 6, 24),
        with_payload: true
      });
      const expectedLanguage = ReligiousRetriever.normalizeFilterValue(input.language);
      const expectedTradition = ReligiousRetriever.normalizeFilterValue(input.tradition);
      return expanded
        .filter((row) => {
          const payload = (row.payload ?? {}) as Record<string, unknown>;
          if (expectedLanguage) {
            const payloadLanguage = ReligiousRetriever.normalizeFilterValue(
              ReligiousRetriever.payloadValue(payload, 'language')
            );
            if (payloadLanguage !== expectedLanguage) return false;
          }
          if (expectedTradition) {
            const payloadTradition = ReligiousRetriever.normalizeFilterValue(
              ReligiousRetriever.payloadValue(payload, 'tradition')
            );
            if (payloadTradition !== expectedTradition) return false;
          }
          return true;
        })
        .slice(0, requestedLimit);
    });

    return result.map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return {
        title: String(payload.title ?? 'Unknown Text'),
        source: String(payload.source ?? 'Unknown Source'),
        passage: String(payload.passage ?? ''),
        tradition: payload.tradition ? String(payload.tradition) : undefined,
        language: payload.language ? String(payload.language) : undefined
      };
    });
  }

  async retrieveStories(input: StoryQuery): Promise<StoryHit[]> {
    let vector: number[];
    try {
      const [embedded] = await this.embeddings.embed([input.query]);
      vector = embedded;
    } catch (error) {
      logger.warn('Story retrieval skipped: embedding generation failed', {
        reason: (error as Error).message
      });
      return [];
    }

    const must: Array<Record<string, unknown>> = [{ key: 'kind', match: { value: 'story' } }];
    if (input.language) must.push({ key: 'language', match: { value: input.language } });
    if (input.tradition) must.push({ key: 'tradition', match: { value: input.tradition } });
    if (input.region) must.push({ key: 'region', match: { value: input.region } });

    const requestedLimit = Math.min(Math.max(input.k ?? 5, 1), 10);
    let result = await this.qdrant.search(env.QDRANT_COLLECTION, {
      vector,
      limit: requestedLimit,
      filter: { must },
      with_payload: true
    }).catch(async (error) => {
      if (!ReligiousRetriever.isMissingPayloadIndexError(error)) {
        throw error;
      }
      logger.warn('Story retrieval filter unavailable; falling back to local payload filtering', {
        reason: ReligiousRetriever.errorForLog(error)
      });
      const expanded = await this.qdrant.search(env.QDRANT_COLLECTION, {
        vector,
        limit: Math.max(requestedLimit * 12, 48),
        with_payload: true
      });
      return ReligiousRetriever.selectStoryRows(expanded, input, requestedLimit);
    });

    let selected = ReligiousRetriever.selectStoryRows(result, input, requestedLimit);
    if (
      selected.length < requestedLimit &&
      (input.language || input.tradition || input.region)
    ) {
      const expanded = await this.qdrant.search(env.QDRANT_COLLECTION, {
        vector,
        limit: Math.max(requestedLimit * 12, 48),
        with_payload: true
      }).catch((error) => {
        logger.warn('Story retrieval relaxed search failed', {
          reason: ReligiousRetriever.errorForLog(error)
        });
        return [];
      });
      if (expanded.length > 0) {
        selected = ReligiousRetriever.selectStoryRows(expanded, input, requestedLimit);
      }
    }

    return selected.map((row) => {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      return {
        title: String(payload.title ?? 'Unknown Story'),
        source: String(payload.source ?? 'Unknown Source'),
        passage: String(payload.passage ?? ''),
        tradition: payload.tradition ? String(payload.tradition) : undefined,
        language: payload.language ? String(payload.language) : undefined,
        storyId: payload.story_id ? String(payload.story_id) : undefined,
        region: payload.region ? String(payload.region) : undefined,
        tone: payload.tone ? String(payload.tone) : undefined,
        moral: payload.moral ? String(payload.moral) : undefined
      };
    });
  }
}
