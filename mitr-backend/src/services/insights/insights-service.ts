import { getFamilyRepository } from '../family/family-repository.js';

const rangeToDays = (range: '24h' | '7d' | '30d'): number => {
  if (range === '24h') return 1;
  if (range === '7d') return 7;
  return 30;
};

export class InsightsService {
  private readonly repo = getFamilyRepository();

  async overview(userId: string) {
    return this.repo.ensureSyntheticInsights(userId);
  }

  async timeline(userId: string, range: '24h' | '7d' | '30d') {
    const overview = await this.repo.ensureSyntheticInsights(userId);
    const days = rangeToDays(range);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return {
      range,
      moodTrend: overview.moodTrend.filter((p) => p.ts >= cutoff),
      engagementTrend: overview.engagementTrend.filter((p) => p.ts >= cutoff)
    };
  }

  async topics(userId: string, range: '7d' | '30d') {
    const overview = await this.repo.ensureSyntheticInsights(userId);
    return {
      range,
      topics: overview.keyTopics
    };
  }

  async concerns(userId: string, status: 'open' | 'all') {
    const concerns = await this.repo.getConcerns(userId);
    if (status === 'all') return concerns;
    return concerns.filter((c) => c.severity === 'high' || c.severity === 'critical');
  }

  async sessions(userId: string, cursor?: string) {
    const overview = await this.repo.ensureSyntheticInsights(userId);
    const items = overview.recommendations.map((r, idx) => ({
      id: r.id,
      ts: Date.now() - idx * 60 * 60 * 1000,
      summary: `${r.title}. ${r.action}`,
      confidence: r.confidence
    }));
    return {
      cursor: cursor ?? null,
      nextCursor: null,
      items
    };
  }
}
