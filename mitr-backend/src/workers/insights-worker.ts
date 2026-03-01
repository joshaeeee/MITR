import { closeRedisConnections } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { InsightsPipelineService } from '../services/insights/insights-pipeline-service.js';
import { closeInsightsQueue, createInsightsWorker } from '../services/insights/queue.js';

const pipeline = new InsightsPipelineService();

const worker = createInsightsWorker(async (job) => {
  await pipeline.processTranscriptJob(job.data);
  logger.info('Insights transcript ingested', {
    transcriptId: job.data.transcriptId,
    userId: job.data.userId,
    sessionId: job.data.sessionId,
    jobId: job.id
  });
});

worker.on('failed', (job, error) => {
  logger.error('Insights job failed', {
    id: job?.id,
    transcriptId: job?.data?.transcriptId,
    userId: job?.data?.userId,
    error: error.message
  });
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info('Insights worker shutting down', { signal });
  const killTimer = setTimeout(() => {
    logger.error('Insights worker forced exit after shutdown timeout', { signal });
    process.exit(1);
  }, 12_000);

  killTimer.unref();

  try {
    await worker.close();
    await closeInsightsQueue();
    await closeRedisConnections();
    logger.info('Insights worker shutdown complete', { signal });
    process.exit(0);
  } catch (error) {
    logger.error('Insights worker shutdown failed', {
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

logger.info('Insights worker started');
