import { DailyDigestService } from './daily-digest-service.js';

export class RealtimeHomeService {
  private readonly digests = new DailyDigestService();

  async getRealtimeForHome(userId: string): Promise<Record<string, unknown> | null> {
    const digest = await this.digests.getRealtimeHomeDigestForUser(userId);
    if (!digest) return null;

    return {
      scoreBand: digest.scoreBand,
      confidence: digest.confidence,
      dataSufficiency: digest.dataSufficiency,
      insufficientConfidence: digest.insufficientConfidence,
      hasConversationData: digest.hasConversationData,
      insightsPending: digest.insightsPending,
      insightState: digest.insightState,
      topConcern: digest.topConcern,
      recommendedAction: digest.recommendedAction,
      lastComputedAt: digest.lastComputedAt
    };
  }
}
