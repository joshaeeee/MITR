import { getInsightsQueueHealth } from './queue.js';
import { InsightsPipelineService, InsightsReadService } from './insights-pipeline-service.js';

export class InsightsService {
  private readonly read = new InsightsReadService();
  private readonly pipeline = new InsightsPipelineService();

  async overview(userId: string) {
    return this.read.overview(userId);
  }

  async timeline(userId: string, range: '24h' | '7d' | '30d') {
    return this.read.timeline(userId, range);
  }

  async topics(userId: string, range: '7d' | '30d') {
    return this.read.topics(userId, range);
  }

  async concerns(userId: string, status: 'open' | 'all') {
    return this.read.concerns(userId, status);
  }

  async sessions(userId: string, cursor?: string) {
    return this.read.sessions(userId, cursor);
  }

  async explanations(userId: string, signalId: string) {
    return this.read.explanations(userId, signalId);
  }

  async checkin(
    userId: string,
    input: {
      moodLabel: 'better' | 'same' | 'worse';
      engagementLabel: 'better' | 'same' | 'worse';
      socialLabel: 'better' | 'same' | 'worse';
      concernLevel?: 'none' | 'low' | 'medium' | 'high';
      notes?: string;
      weekStartDate?: string;
    }
  ) {
    return this.pipeline.addCheckin({
      userId,
      moodLabel: input.moodLabel,
      engagementLabel: input.engagementLabel,
      socialLabel: input.socialLabel,
      concernLevel: input.concernLevel,
      notes: input.notes,
      weekStartDate: input.weekStartDate
    });
  }

  async pipelineHealth(userId: string) {
    const [readHealth, queue] = await Promise.all([
      this.read.pipelineHealth(userId),
      getInsightsQueueHealth().catch(() => ({
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0
      }))
    ]);
    return {
      ...readHealth,
      queue
    };
  }
}
