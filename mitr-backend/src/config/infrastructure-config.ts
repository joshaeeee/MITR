const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
};

export const infrastructureConfig = Object.freeze({
  get postgresUrl() {
    return requireEnv('POSTGRES_URL');
  },
  get redisUrl() {
    return process.env.REDIS_URL?.trim();
  }
});
