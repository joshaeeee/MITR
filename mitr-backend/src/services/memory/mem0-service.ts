import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface Mem0Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface Mem0AddResult {
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | string;
  eventId?: string;
  message?: string;
  raw: unknown;
}

export interface Mem0SearchResult {
  id: string;
  memory: string;
  score?: number;
  metadata: Record<string, unknown>;
  categories: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface Mem0ScopedAddInput {
  userId: string;
  elderId?: string | null;
  messages: Mem0Message[];
  metadata?: Record<string, unknown>;
  customInstructions?: string;
  infer?: boolean;
  runId?: string | null;
  timeoutMs?: number;
}

export interface Mem0ScopedSearchInput {
  userId: string;
  elderId?: string | null;
  query: string;
  limit?: number;
  threshold?: number;
  rerank?: boolean;
  referenceDate?: string | number;
  timeoutMs?: number;
}

export const mem0UserIdFor = (userId: string, elderId?: string | null): string => {
  const normalizedElderId = elderId?.trim();
  return normalizedElderId ? `elder:${normalizedElderId}` : `user:${userId}`;
};

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];

export const MITR_MEM0_CUSTOM_INSTRUCTIONS = `
Mitr/Reca memory rules for elders:

Store durable, user-specific facts that will improve future care or companionship:
- stable preferences, dislikes, routines, habits, hobbies, spiritual/content interests, family relationships, boundaries
- confirmed medication/routine facts and user-stated care preferences
- recurring behavioral patterns when the user states them clearly

Do not store:
- one-off small talk with no future value
- speculation as confirmed fact, especially health speculation
- raw addresses, phone numbers, financial IDs, government IDs, passwords, secrets, or private credentials
- caregiver-visible health conclusions unless confirmed by the user/caregiver or a medication/reminder event

For uncertain health statements, store only that the user mentioned concern or uncertainty; do not convert it into a diagnosis.
Prefer concise memories that are useful for natural future conversation.
`.trim();

export class Mem0Service {
  private readonly headers: Record<string, string>;
  private readonly baseUrl: string;

  constructor() {
    if (!env.MEM0_API_KEY) {
      throw new Error('MEM0_API_KEY is required to use Mem0Service');
    }

    this.baseUrl = env.MEM0_BASE_URL.replace(/\/$/, '');
    this.headers = {
      Authorization: `Token ${env.MEM0_API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };

    if (env.MEM0_ORG_ID) this.headers['x-mem0-org-id'] = env.MEM0_ORG_ID;
    if (env.MEM0_PROJECT_ID) this.headers['x-mem0-project-id'] = env.MEM0_PROJECT_ID;
  }

  async addMemory(userId: string, conversation: Mem0Message[], metadata?: Record<string, unknown>): Promise<Mem0AddResult> {
    return this.addScopedMemory({
      userId,
      messages: conversation,
      metadata
    });
  }

  async addScopedMemory(input: Mem0ScopedAddInput): Promise<Mem0AddResult> {
    const mem0UserId = mem0UserIdFor(input.userId, input.elderId);
    const payload = {
      user_id: mem0UserId,
      messages: input.messages,
      metadata: {
        ...(input.metadata ?? {}),
        mitrUserId: input.userId,
        elderId: input.elderId ?? null,
        appId: env.MEM0_APP_ID,
        agentId: env.MEM0_AGENT_ID,
        mem0ScopeVersion: 'elder_user_v1'
      },
      infer: input.infer ?? true,
      custom_instructions: input.customInstructions ?? MITR_MEM0_CUSTOM_INSTRUCTIONS
    };

    logger.info('Mem0 v3 add request', {
      mem0UserId,
      messages: input.messages.length,
      hasMetadata: Boolean(input.metadata)
    });

    const response = await this.requestJson('/v3/memories/add/', {
      method: 'POST',
      body: payload,
      timeoutMs: input.timeoutMs ?? env.MEM0_ADD_TIMEOUT_MS
    });

    const data = asObject(response);
    const result = {
      status: asString(data.status) ?? 'PENDING',
      eventId: asString(data.event_id),
      message: asString(data.message),
      raw: response
    };
    logger.info('Mem0 v3 add queued', {
      mem0UserId,
      status: result.status,
      eventId: result.eventId
    });
    return result;
  }

  async searchMemory(userId: string, query: string, limit = 5): Promise<string[]> {
    const results = await this.searchScopedMemories({
      userId,
      query,
      limit
    });
    return results.map((result) => result.memory).filter((item) => item.length > 0);
  }

  async searchScopedMemories(input: Mem0ScopedSearchInput): Promise<Mem0SearchResult[]> {
    const mem0UserId = mem0UserIdFor(input.userId, input.elderId);
    logger.info('Mem0 v3 search request', {
      mem0UserId,
      limit: input.limit ?? 5,
      queryChars: input.query.length
    });

    const payload: Record<string, unknown> = {
      query: input.query,
      filters: { user_id: mem0UserId },
      top_k: input.limit ?? 5,
      threshold: input.threshold ?? env.MEM0_SEARCH_THRESHOLD,
      rerank: input.rerank ?? env.MEM0_SEARCH_RERANK
    };
    if (input.referenceDate !== undefined) payload.reference_date = input.referenceDate;

    const response = await this.requestJson('/v3/memories/search/', {
      method: 'POST',
      body: payload,
      timeoutMs: input.timeoutMs ?? env.MEM0_SEARCH_TIMEOUT_MS
    });

    const data = asObject(response);
    const rows = Array.isArray(data.results) ? data.results : Array.isArray(response) ? response : [];
    const memories = rows
      .map((row) => this.parseSearchRow(row))
      .filter((row): row is Mem0SearchResult => Boolean(row));
    logger.info('Mem0 v3 search success', { mem0UserId, count: memories.length });
    return memories;
  }

  async getEvent(eventId: string, timeoutMs = env.MEM0_SEARCH_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return asObject(
      await this.requestJson(`/v1/event/${encodeURIComponent(eventId)}/`, {
        method: 'GET',
        timeoutMs
      })
    );
  }

  private parseSearchRow(row: unknown): Mem0SearchResult | null {
    const item = asObject(row);
    const id = asString(item.id);
    const memory = asString(item.memory) ?? asString(item.text);
    if (!id || !memory) return null;
    return {
      id,
      memory,
      score: asNumber(item.score),
      metadata: asObject(item.metadata),
      categories: asStringArray(item.categories),
      createdAt: asString(item.created_at),
      updatedAt: asString(item.updated_at)
    };
  }

  private async requestJson(
    path: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      timeoutMs: number;
    }
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: this.headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`Mem0 ${options.method} ${path} timed out after ${options.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      logger.error('Mem0 request failed', {
        path,
        status: response.status,
        body: body.slice(0, 500)
      });
      throw new Error(`Mem0 request failed (${response.status}): ${body}`);
    }

    return response.json();
  }
}
