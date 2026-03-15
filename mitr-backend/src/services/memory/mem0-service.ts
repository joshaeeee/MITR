import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

interface Mem0Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class Mem0Service {
  private headers: Record<string, string>;

  constructor() {
    this.headers = {
      Authorization: `Token ${env.MEM0_API_KEY}`,
      'Content-Type': 'application/json'
    };

    if (env.MEM0_ORG_ID) this.headers['x-mem0-org-id'] = env.MEM0_ORG_ID;
    if (env.MEM0_PROJECT_ID) this.headers['x-mem0-project-id'] = env.MEM0_PROJECT_ID;
  }

  async addMemory(userId: string, conversation: Mem0Message[], metadata?: Record<string, unknown>): Promise<void> {
    const payload = {
      user_id: userId,
      messages: conversation,
      metadata,
      infer: true,
      llm: {
        provider: 'sarvam'
      }
    };
    logger.info('Mem0 add request', {
      userId,
      messages: conversation.length,
      hasMetadata: Boolean(metadata)
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.MEM0_ADD_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${env.MEM0_BASE_URL}/v1/memories/`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        logger.warn('Mem0 add timed out', {
          userId,
          messages: conversation.length,
          timeoutMs: env.MEM0_ADD_TIMEOUT_MS
        });
        throw new Error(`Mem0 add timed out after ${env.MEM0_ADD_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text();
      logger.error('Mem0 add failed', { status: res.status, body: body.slice(0, 280) });
      throw new Error(`Mem0 add failed (${res.status}): ${body}`);
    }
    logger.info('Mem0 add success', { userId });
  }

  async searchMemory(userId: string, query: string, limit = 5): Promise<string[]> {
    logger.info('Mem0 search request', { userId, limit, queryChars: query.length });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env.MEM0_SEARCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${env.MEM0_BASE_URL}/v1/memories/search/`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ user_id: userId, query, limit }),
        signal: controller.signal
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        logger.warn('Mem0 search timed out', {
          userId,
          limit,
          queryChars: query.length,
          timeoutMs: env.MEM0_SEARCH_TIMEOUT_MS
        });
        return [];
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text();
      logger.error('Mem0 search failed', { status: res.status, body: body.slice(0, 280) });
      throw new Error(`Mem0 search failed (${res.status}): ${body}`);
    }

    const payload = (await res.json()) as unknown;
    const rows = Array.isArray(payload)
      ? payload
      : ((payload as { memories?: Array<{ memory?: string; text?: string }> }).memories ?? []);
    const memories = rows
      .map((item) => String((item as { memory?: string; text?: string }).memory ?? (item as { text?: string }).text ?? ''))
      .filter((item) => item.length > 0);
    logger.info('Mem0 search success', { userId, count: memories.length });
    return memories;
  }
}
