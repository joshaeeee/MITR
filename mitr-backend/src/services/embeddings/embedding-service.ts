import { env } from '../../config/env.js';

const defaultEmbeddingProviderUrl = (): string => `${env.OPENROUTER_BASE_URL.replace(/\/$/, '')}/embeddings`;

export class EmbeddingService {
  private cache = new Map<string, { vector: number[]; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 30 * 60 * 1000;
  // Conservative default batch size to avoid provider max-tokens-per-request limits.
  // Can be overridden via env if needed.
  private static readonly MAX_BATCH_SIZE = Number(env.EMBEDDING_MAX_BATCH_SIZE ?? 64);

  async embed(texts: string[]): Promise<number[][]> {
    const providerUrl = env.EMBEDDING_PROVIDER_URL ?? defaultEmbeddingProviderUrl();
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    };

    if (env.EMBEDDING_AUTH_TYPE !== 'none') {
      const apiKey = env.EMBEDDING_API_KEY ?? env.OPENROUTER_API_KEY ?? env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          'Embedding provider auth is enabled but no key found. Set EMBEDDING_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY.'
        );
      }
      if (env.EMBEDDING_AUTH_TYPE === 'bearer') {
        headers.Authorization = `Bearer ${apiKey}`;
      } else {
        headers['x-api-key'] = apiKey;
      }
    }

    const outputs: Array<number[] | null> = texts.map((t) => {
      const key = t.trim().toLowerCase();
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.vector;
      return null;
    });
    const missing = texts
      .map((text, index) => ({ text, index }))
      .filter((_, index) => outputs[index] === null);

    if (missing.length > 0) {
      const batchSize =
        Number.isFinite(EmbeddingService.MAX_BATCH_SIZE) && EmbeddingService.MAX_BATCH_SIZE > 0
          ? EmbeddingService.MAX_BATCH_SIZE
          : 64;

      for (let start = 0; start < missing.length; start += batchSize) {
        const batch = missing.slice(start, start + batchSize);

        const response = await fetch(providerUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: env.EMBEDDING_MODEL, input: batch.map((m) => m.text) })
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Embedding provider failed (${response.status}): ${body}`);
        }

        const payload = (await response.json()) as { data?: Array<{ embedding: number[] }> };
        if (!payload.data || payload.data.length !== batch.length) {
          throw new Error('Embedding provider returned invalid shape');
        }
        for (let i = 0; i < batch.length; i += 1) {
          const missingEntry = batch[i];
          const vector = payload.data[i].embedding;
          outputs[missingEntry.index] = vector;
          this.cache.set(missingEntry.text.trim().toLowerCase(), {
            vector,
            expiresAt: Date.now() + EmbeddingService.CACHE_TTL_MS
          });
        }
      }
    }

    if (outputs.some((v) => !v)) {
      throw new Error('Embedding cache resolution failed unexpectedly');
    }
    return outputs as number[][];
  }
}
