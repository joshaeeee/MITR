import { getInsightsQueueHealth } from './queue.js';
import { getDigestQueueHealth } from './digest-queue.js';
import { DailyDigestService } from './daily-digest-service.js';
import { InsightsPipelineService, InsightsReadService } from './insights-pipeline-service.js';
import {
  RecommendationFeedbackService,
  type RecommendationFeedbackAction
} from './recommendation-feedback-service.js';

export class InsightsService {
  private readonly read = new InsightsReadService();
  private readonly pipeline = new InsightsPipelineService();
  private readonly digest = new DailyDigestService();
  private readonly recommendationFeedback = new RecommendationFeedbackService();

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

  async dailyDigestToday(userId: string) {
    return this.digest.getTodayDigestForUser(userId);
  }

  async dailyDigestByDate(userId: string, date: string) {
    return this.digest.getDigestForUserByDate(userId, date);
  }

  async dailyDigestRange(userId: string, from: string, to: string) {
    return this.digest.getDigestRangeForUser(userId, from, to);
  }

  async activeRecommendations(userId: string) {
    return this.recommendationFeedback.getActiveForUser(userId);
  }

  async submitRecommendationFeedback(
    userId: string,
    recommendationId: string,
    action: RecommendationFeedbackAction,
    notes?: string
  ) {
    return this.recommendationFeedback.addFeedback({
      userId,
      recommendationId,
      action,
      notes
    });
  }

  async confirmRecommendationAction(userId: string, recommendationId: string, confirmed: boolean) {
    return this.recommendationFeedback.confirmAction({ userId, recommendationId, confirmed });
  }

  async checkin(
    userId: string,
    input: {
      period: 'day' | 'week';
      moodLabel?: 'better' | 'same' | 'worse';
      engagementLabel?: 'better' | 'same' | 'worse';
      socialLabel?: 'better' | 'same' | 'worse';
      matched?: boolean;
      concernLevel?: 'none' | 'low' | 'medium' | 'high';
      notes?: string;
      weekStartDate?: string;
    }
  ) {
    if (input.period === 'day') {
      // Daily quick check-ins are normalized into the existing weekly check-in schema.
      const normalized = input.matched === false ? 'worse' : 'same';
      return this.pipeline.addCheckin({
        userId,
        moodLabel: normalized,
        engagementLabel: normalized,
        socialLabel: normalized,
        concernLevel: input.concernLevel,
        notes: input.notes,
        weekStartDate: input.weekStartDate
      });
    }

    return this.pipeline.addCheckin({
      userId,
      moodLabel: input.moodLabel ?? 'same',
      engagementLabel: input.engagementLabel ?? 'same',
      socialLabel: input.socialLabel ?? 'same',
      concernLevel: input.concernLevel,
      notes: input.notes,
      weekStartDate: input.weekStartDate
    });
  }

  async pipelineHealth(userId: string) {
    const [readHealth, queue, digestQueue] = await Promise.all([
      this.read.pipelineHealth(userId),
      getInsightsQueueHealth().catch(() => ({
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0
      })),
      getDigestQueueHealth().catch(() => ({
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0
      }))
    ]);
    return {
      ...readHealth,
      queue,
      digestQueue
    };
  }
}
