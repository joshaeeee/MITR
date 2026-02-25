import { Queue, Worker, JobsOptions } from 'bullmq';
import { logger } from '../../lib/logger.js';
import { getSharedBullRedisClient } from '../../lib/redis.js';

export const REMINDER_QUEUE = 'reminders';
let reminderQueue: Queue<ReminderJobPayload> | null = null;
const reminderWorkers = new Set<Worker<ReminderJobPayload>>();

export type ReminderJobPayload = {
  reminderId: string;
  userId: string;
  title: string;
  language?: string;
};

export const scheduleReminderJob = async (
  payload: ReminderJobPayload,
  delayMs: number,
  options?: JobsOptions
): Promise<void> => {
  const normalizedDelay = Math.max(delayMs, 0);
  if (delayMs < 0) {
    logger.warn('Reminder delay is negative; clamping to immediate execution', {
      reminderId: payload.reminderId,
      userId: payload.userId,
      delayMs
    });
  }

  if (!reminderQueue) {
    reminderQueue = new Queue<ReminderJobPayload>(REMINDER_QUEUE, { connection: getSharedBullRedisClient() });
  }

  await reminderQueue.add('reminder.fire', payload, {
    delay: normalizedDelay,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 200,
    removeOnFail: 200,
    ...options
  });
};

export const createReminderWorker = (
  processor: (job: { data: ReminderJobPayload; id?: string }) => Promise<void>
): Worker<ReminderJobPayload> => {
  const worker = new Worker<ReminderJobPayload>(
    REMINDER_QUEUE,
    async (job) => processor({ data: job.data, id: String(job.id) }),
    { connection: getSharedBullRedisClient() }
  );
  reminderWorkers.add(worker);
  worker.on('closed', () => {
    reminderWorkers.delete(worker);
  });
  return worker;
};

export const closeReminderQueue = async (): Promise<void> => {
  const closers: Array<Promise<unknown>> = [];
  for (const worker of reminderWorkers) {
    closers.push(worker.close());
  }
  if (reminderQueue) {
    closers.push(reminderQueue.close());
    reminderQueue = null;
  }
  await Promise.allSettled(closers);
};
