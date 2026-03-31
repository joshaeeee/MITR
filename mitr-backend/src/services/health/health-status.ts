export type DependencyHealthStatus = 'ok' | 'error' | 'not_configured';

export interface DependencyHealth {
  status: DependencyHealthStatus;
  required: boolean;
  configured: boolean;
  durationMs: number;
  detail?: string;
  metrics?: Record<string, number>;
}

export interface ApiHealthStatus {
  ok: boolean;
  service: 'mitr-api';
  timestamp: string;
  uptimeSec: number;
  dependencies: Record<string, DependencyHealth>;
}

const SERVICE_NAME = 'mitr-api';

const serializeError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const checkDependency = async <TResult extends Record<string, number> | void>(
  name: string,
  options: {
    configured: boolean;
    required: boolean;
    timeoutMs: number;
    run: () => Promise<TResult>;
  }
): Promise<DependencyHealth> => {
  if (!options.configured) {
    return {
      status: 'not_configured',
      required: options.required,
      configured: false,
      durationMs: 0
    };
  }

  const startedAt = Date.now();
  try {
    const metrics = await withTimeout(options.run(), options.timeoutMs, name);
    const health: DependencyHealth = {
      status: 'ok',
      required: options.required,
      configured: true,
      durationMs: Date.now() - startedAt
    };
    if (metrics && typeof metrics === 'object') {
      health.metrics = metrics;
    }
    return health;
  } catch (error) {
    return {
      status: 'error',
      required: options.required,
      configured: true,
      durationMs: Date.now() - startedAt,
      detail: serializeError(error)
    };
  }
};

export const buildApiHealthStatus = (
  dependencies: ApiHealthStatus['dependencies'],
  now = new Date(),
  uptimeSec = Math.round(process.uptime())
): ApiHealthStatus => ({
  ok: Object.values(dependencies).every((dependency) => dependency.status === 'ok' || dependency.required === false),
  service: SERVICE_NAME,
  timestamp: now.toISOString(),
  uptimeSec,
  dependencies
});

export const getApiHealthStatus = async (): Promise<ApiHealthStatus> => {
  const [
    { pgPool },
    { getSharedRedisClient },
    { infrastructureConfig },
    { observabilityConfig },
    { getReminderQueueHealth },
    { getInsightsQueueHealth },
    { getDigestQueueHealth }
  ] = await Promise.all([
    import('../../db/client.js'),
    import('../../lib/redis.js'),
    import('../../config/infrastructure-config.js'),
    import('../../config/observability-config.js'),
    import('../reminders/queue.js'),
    import('../insights/queue.js'),
    import('../insights/digest-queue.js')
  ]);

  const redisConfigured = Boolean(infrastructureConfig.redisUrl);
  const redisClient = getSharedRedisClient();
  const timeoutMs = observabilityConfig.healthCheckTimeoutMs;

  const [postgres, redis, reminderQueue, insightsQueue, digestQueue] = await Promise.all([
    checkDependency('postgres', {
      configured: true,
      required: true,
      timeoutMs,
      run: async () => {
        await pgPool.query('select 1');
      }
    }),
    checkDependency('redis', {
      configured: redisConfigured,
      required: redisConfigured,
      timeoutMs,
      run: async () => {
        if (!redisClient) {
          throw new Error('Redis client unavailable');
        }
        const response = await redisClient.ping();
        if (response !== 'PONG') {
          throw new Error(`Unexpected Redis ping response: ${response}`);
        }
      }
    }),
    checkDependency('reminderQueue', {
      configured: redisConfigured,
      required: redisConfigured,
      timeoutMs,
      run: async () => getReminderQueueHealth()
    }),
    checkDependency('insightsQueue', {
      configured: redisConfigured,
      required: redisConfigured,
      timeoutMs,
      run: async () => getInsightsQueueHealth()
    }),
    checkDependency('digestQueue', {
      configured: redisConfigured,
      required: redisConfigured,
      timeoutMs,
      run: async () => getDigestQueueHealth()
    })
  ]);

  return buildApiHealthStatus({
    postgres,
    redis,
    reminderQueue,
    insightsQueue,
    digestQueue
  });
};
