import { env } from '../config/env.js';
import { closeRedisConnections } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { closeDigestQueue, createDigestWorker, ensureDigestRepeatableScanWithPattern } from '../services/insights/digest-queue.js';
import { DigestNotifierService } from '../services/notifications/digest-notifier-service.js';

const notifier = new DigestNotifierService();

const worker = createDigestWorker(async (job) => {
  const result = await notifier.dispatchDueDigests(new Date(job.data.triggeredAtIso));
  logger.info('Digest scan completed', {
    jobId: job.id,
    triggeredAtIso: job.data.triggeredAtIso,
    dispatched: result.dispatched,
    skipped: result.skipped
  });
});

worker.on('failed', (job, error) => {
  logger.error('Digest job failed', {
    jobId: job?.id,
    triggeredAtIso: job?.data?.triggeredAtIso,
    error: error.message
  });
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info('Digest worker shutting down', { signal });
  const killTimer = setTimeout(() => {
    logger.error('Digest worker forced exit after shutdown timeout', { signal });
    process.exit(1);
  }, 12_000);
  killTimer.unref();

  try {
    await worker.close();
    await closeDigestQueue();
    await closeRedisConnections();
    logger.info('Digest worker shutdown complete', { signal });
    process.exit(0);
  } catch (error) {
    logger.error('Digest worker shutdown failed', {
      signal,
      error: (error as Error).message
    });
    process.exit(1);
  }
};

const start = async (): Promise<void> => {
  await ensureDigestRepeatableScanWithPattern(env.DIGEST_JOB_CRON_UTC);
  logger.info('Digest worker started', { cronUtc: env.DIGEST_JOB_CRON_UTC });
};

void start().catch((error) => {
  logger.error('Digest worker failed at startup', { error: (error as Error).message });
  process.exit(1);
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

