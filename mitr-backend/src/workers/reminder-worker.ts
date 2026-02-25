import { createReminderWorker, closeReminderQueue } from '../services/reminders/queue.js';
import { logger } from '../lib/logger.js';
import { SessionStore } from '../services/session-store.js';
import { closeRedisConnections } from '../lib/redis.js';

const store = new SessionStore();

const worker = createReminderWorker(async (job) => {
  const dedupeKey = `reminder_job:${job.id ?? job.data.reminderId}`;
  const accepted = await store.pushUserEvent(
    job.data.userId,
    {
      type: 'reminder_fired',
      payload: {
        reminderId: job.data.reminderId,
        title: job.data.title,
        language: job.data.language,
        firedAt: Date.now()
      }
    },
    dedupeKey
  );

  logger.info('Reminder fired', {
    reminderId: job.data.reminderId,
    userId: job.data.userId,
    title: job.data.title,
    queuedForDelivery: accepted,
    workerJobId: job.id
  });
});

worker.on('failed', (job, error) => {
  logger.error('Reminder job failed', { id: job?.id, error: error.message });
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info('Reminder worker shutting down', { signal });
  const killTimer = setTimeout(() => {
    logger.error('Reminder worker forced exit after shutdown timeout', { signal });
    process.exit(1);
  }, 10_000);

  killTimer.unref();

  try {
    await worker.close();
    await closeReminderQueue();
    await closeRedisConnections();
    logger.info('Reminder worker shutdown complete', { signal });
    process.exit(0);
  } catch (error) {
    logger.error('Reminder worker shutdown failed', {
      signal,
      error: (error as Error).message
    });
    process.exit(1);
  }
};

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

logger.info('Reminder worker started');
