import { JobsOptions, Queue, Worker } from 'bullmq';
import { getSharedBullRedisClient } from '../../lib/redis.js';

export const INSIGHTS_QUEUE = 'insights.analytics';

export type InsightIngestJobPayload = {
  transcriptId: string;
  userId: string;
  sessionId: string;
  transcript: string;
  language?: string | null;
  transcribedAtIso: string;
};

let insightsQueue: Queue<InsightIngestJobPayload> | null = null;
const insightWorkers = new Set<Worker<InsightIngestJobPayload>>();

const getQueue = (): Queue<InsightIngestJobPayload> => {
  if (!insightsQueue) {
    insightsQueue = new Queue<InsightIngestJobPayload>(INSIGHTS_QUEUE, {
      connection: getSharedBullRedisClient()
    });
  }
  return insightsQueue;
};

export const scheduleInsightIngestJob = async (
  payload: InsightIngestJobPayload,
  options?: JobsOptions
): Promise<void> => {
  await getQueue().add('insights.transcript.ingest', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1500 },
    removeOnComplete: 500,
    removeOnFail: 500,
    jobId: payload.transcriptId,
    ...options
  });
};

export const createInsightsWorker = (
  processor: (job: { data: InsightIngestJobPayload; id?: string }) => Promise<void>
): Worker<InsightIngestJobPayload> => {
  const worker = new Worker<InsightIngestJobPayload>(
    INSIGHTS_QUEUE,
    async (job) => processor({ data: job.data, id: String(job.id) }),
    { connection: getSharedBullRedisClient() }
  );

  insightWorkers.add(worker);
  worker.on('closed', () => insightWorkers.delete(worker));
  return worker;
};

export const getInsightsQueueHealth = async (): Promise<{
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

export const closeInsightsQueue = async (): Promise<void> => {
  const closers: Array<Promise<unknown>> = [];

  for (const worker of insightWorkers) {
    closers.push(worker.close());
  }

  if (insightsQueue) {
    closers.push(insightsQueue.close());
    insightsQueue = null;
  }

  await Promise.allSettled(closers);
};
