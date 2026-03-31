import { env } from './env.js';

export const infrastructureConfig = Object.freeze({
  get postgresUrl() {
    return env.POSTGRES_URL;
  },
  get redisUrl() {
    return env.REDIS_URL;
  }
});
