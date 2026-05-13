import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../../config/env.js';

const isHttps = (raw: string): boolean => {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
};

export const createQdrantClient = (): QdrantClient => {
  if (!env.QDRANT_URL) {
    throw new Error('QDRANT_URL is required to create a Qdrant client');
  }

  const secure = isHttps(env.QDRANT_URL);

  return new QdrantClient({
    url: env.QDRANT_URL,
    apiKey: secure ? env.QDRANT_API_KEY : undefined,
    checkCompatibility: env.QDRANT_CHECK_COMPATIBILITY
  });
};
