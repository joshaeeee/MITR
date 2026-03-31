import { Redis } from 'ioredis';
import { infrastructureConfig } from '../config/infrastructure-config.js';

let sharedRedisClient: Redis | null = null;
let sharedBullRedisClient: Redis | null = null;

const buildRedisClient = (url: string, maxRetriesPerRequest: number | null): Redis =>
  new Redis(url, { maxRetriesPerRequest });

export const getSharedRedisClient = (): Redis | null => {
  if (!infrastructureConfig.redisUrl) return null;
  if (!sharedRedisClient) {
    sharedRedisClient = buildRedisClient(infrastructureConfig.redisUrl, 2);
  }
  return sharedRedisClient;
};

export const getSharedBullRedisClient = (): Redis => {
  if (!sharedBullRedisClient) {
    sharedBullRedisClient = buildRedisClient(infrastructureConfig.redisUrl ?? 'redis://localhost:6379', null);
  }
  return sharedBullRedisClient;
};

export const closeRedisConnections = async (): Promise<void> => {
  const closers: Array<Promise<unknown>> = [];

  if (sharedRedisClient) {
    closers.push(sharedRedisClient.quit().catch(() => sharedRedisClient?.disconnect()));
    sharedRedisClient = null;
  }

  if (sharedBullRedisClient) {
    closers.push(sharedBullRedisClient.quit().catch(() => sharedBullRedisClient?.disconnect()));
    sharedBullRedisClient = null;
  }

  await Promise.allSettled(closers);
};
