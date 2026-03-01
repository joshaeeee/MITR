import { JobsOptions, Queue, Worker } from 'bullmq';
import { getSharedBullRedisClient } from '../../lib/redis.js';

export const INSIGHTS_DIGEST_QUEUE = 'insights.digest';

export type DigestJobPayload = {
  triggeredAtIso: string;
};

let digestQueue: Queue<DigestJobPayload> | null = null;
const digestWorkers = new Set<Worker<DigestJobPayload>>();

const getQueue = (): Queue<DigestJobPayload> => {
  if (!digestQueue) {
    digestQueue = new Queue<DigestJobPayload>(INSIGHTS_DIGEST_QUEUE, {
      connection: getSharedBullRedisClient()
    });
  }
  return digestQueue;
};

export const scheduleDigestScan = async (payload: DigestJobPayload, options?: JobsOptions): Promise<void> => {
  await getQueue().add('insights.digest.scan', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1500 },
    removeOnComplete: 200,
    removeOnFail: 200,
    ...options
  });
};

export const ensureDigestRepeatableScan = async (): Promise<void> => {
  await ensureDigestRepeatableScanWithPattern('* * * * *');
};

export const ensureDigestRepeatableScanWithPattern = async (pattern: string): Promise<void> => {
  await getQueue().add(
    'insights.digest.scan.repeat',
    { triggeredAtIso: new Date().toISOString() },
    {
      repeat: { pattern },
      jobId: 'insights.digest.scan.repeat.v1',
      removeOnComplete: 5,
      removeOnFail: 20
    }
  );
};

export const getDigestQueueHealth = async (): Promise<{
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}> => {
  const counts = await getQueue().getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0
  };
};

export const createDigestWorker = (
  processor: (job: { data: DigestJobPayload; id?: string }) => Promise<void>
): Worker<DigestJobPayload> => {
  const worker = new Worker<DigestJobPayload>(
    INSIGHTS_DIGEST_QUEUE,
    async (job) => processor({ data: job.data, id: String(job.id) }),
    { connection: getSharedBullRedisClient() }
  );

  digestWorkers.add(worker);
  worker.on('closed', () => digestWorkers.delete(worker));
  return worker;
};

export const closeDigestQueue = async (): Promise<void> => {
  const closers: Array<Promise<unknown>> = [];
  for (const worker of digestWorkers) {
    closers.push(worker.close());
  }
  if (digestQueue) {
    closers.push(digestQueue.close());
    digestQueue = null;
  }
  await Promise.allSettled(closers);
};
