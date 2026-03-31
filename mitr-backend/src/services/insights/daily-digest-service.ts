import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  concernSignals,
  insightDailyDigests,
  insightDailyScores,
  insightRecommendations,
  insightSignalEvents,
  userInputTranscripts
} from '../../db/schema.js';
import { getFamilyRepository } from '../family/family-repository.js';
import { getInsightsQueueHealth } from './queue.js';
import { toIsoDateKey, dateKeyToEpochMs, clamp } from './insights-scoring.js';

export type DailyDigestSummary = {
  elderId: string;
  dateKey: string;
  scoreBand: 'stable' | 'watch' | 'concern';
  confidence: number;
  dataSufficiency: number;
  insufficientConfidence: boolean;
  hasConversationData: boolean;
  insightsPending: boolean;
  insightState: 'no_conversations' | 'processing_pending' | 'low_confidence' | 'ready';
  lastComputedAt: string | null;
  topTopics: Array<{ topic: string; score: number }>;
  topConcern: {
    id: string;
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    confidence: 'low' | 'medium' | 'high';
    message: string;
  } | null;
  recommendedAction: {
    id: string;
    title: string;
    why: string;
    actionText: string;
    confidence: number;
    status: 'active' | 'accepted' | 'dismissed' | 'completed';
  } | null;
  generatedAt: string;
};

const confidenceThreshold = 45;
const dataSufficiencyThreshold = 35;

export const isInsufficientConfidence = (confidence: number, dataSufficiency: number): boolean =>
  confidence < confidenceThreshold || dataSufficiency < dataSufficiencyThreshold;

export class DailyDigestService {
  private readonly repo = getFamilyRepository();

  private async getElderIdForUser(userId: string): Promise<string | null> {
    const elder = await this.repo.getElderByUser(userId);
    return elder?.id ?? null;
  }

  async getTodayDateKeyForUser(userId: string): Promise<string> {
    const elder = await this.repo.getElderByUser(userId);
    const tz = elder?.timezone?.trim() || 'Asia/Kolkata';
    return toIsoDateKey(new Date(), tz);
  }

  private topicScoresFromMetrics(metrics: Record<string, unknown> | null): Array<{ topic: string; score: number }> {
    const topicCounts = (metrics?.topicCounts as Record<string, number> | undefined) ?? {};
    const max = Math.max(1, ...Object.values(topicCounts));
    return Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic, count]) => ({ topic, score: clamp((count / max) * 100) / 100 }));
  }

  private async rollingFallback(elderId: string, dateKey: string): Promise<{
    confidence: number;
    dataSufficiency: number;
    scoreBand: 'stable' | 'watch' | 'concern';
  } | null> {
    const windowStartDate = new Date(`${dateKey}T00:00:00+05:30`);
    windowStartDate.setDate(windowStartDate.getDate() - 2);
    const fromKey = toIsoDateKey(windowStartDate);

    const rows = await db
      .select()
      .from(insightDailyScores)
      .where(and(eq(insightDailyScores.elderId, elderId), gte(insightDailyScores.dateKey, fromKey), lte(insightDailyScores.dateKey, dateKey)))
      .orderBy(asc(insightDailyScores.dateKey));

    if (rows.length === 0) return null;

    const avgConfidence = Math.round(rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length);
    const avgSufficiency = Math.round(rows.reduce((sum, row) => sum + row.dataSufficiency, 0) / rows.length);
    const scoreBand = rows[rows.length - 1]!.scoreBand;

    return {
      confidence: avgConfidence,
      dataSufficiency: avgSufficiency,
      scoreBand
    };
  }

  private async buildProcessingState(userId: string, digest: DailyDigestSummary | null): Promise<{
    hasConversationData: boolean;
    insightsPending: boolean;
    insightState: DailyDigestSummary['insightState'];
  }> {
    const [transcriptCountRow, latestTranscriptRow, queueHealth] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(userInputTranscripts)
        .where(eq(userInputTranscripts.userId, userId))
        .then((rows) => rows[0] ?? { count: 0 }),
      db
        .select({ createdAt: userInputTranscripts.createdAt })
        .from(userInputTranscripts)
        .where(eq(userInputTranscripts.userId, userId))
        .orderBy(desc(userInputTranscripts.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      getInsightsQueueHealth().catch(() => ({
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0
      }))
    ]);

    const transcriptCount = Number(transcriptCountRow.count ?? 0);
    if (transcriptCount === 0) {
      return {
        hasConversationData: false,
        insightsPending: false,
        insightState: 'no_conversations'
      };
    }

    const queuePending = (queueHealth.waiting ?? 0) + (queueHealth.active ?? 0) + (queueHealth.delayed ?? 0) > 0;
    const latestTranscriptAt = latestTranscriptRow?.createdAt?.getTime() ?? 0;
    const digestGeneratedAt = digest?.generatedAt ? Date.parse(digest.generatedAt) : 0;
    const pendingBecauseFreshData = latestTranscriptAt > 0 && digestGeneratedAt > 0 && latestTranscriptAt > digestGeneratedAt;

    if (!digest || queuePending || pendingBecauseFreshData) {
      return {
        hasConversationData: true,
        insightsPending: true,
        insightState: 'processing_pending'
      };
    }

    if (digest.insufficientConfidence) {
      return {
        hasConversationData: true,
        insightsPending: false,
        insightState: 'low_confidence'
      };
    }

    return {
      hasConversationData: true,
      insightsPending: false,
      insightState: 'ready'
    };
  }

  async materializeDigestByElder(elderId: string, dateKey: string): Promise<DailyDigestSummary | null> {
    const [daily] = await db
      .select()
      .from(insightDailyScores)
      .where(and(eq(insightDailyScores.elderId, elderId), eq(insightDailyScores.dateKey, dateKey)))
      .limit(1);

    if (!daily) return null;

    const [topConcern, recommendedAction] = await Promise.all([
      db
        .select()
        .from(concernSignals)
        .where(and(eq(concernSignals.elderId, elderId), eq(concernSignals.status, 'open')))
        .orderBy(desc(concernSignals.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(insightRecommendations)
        .where(
          and(
            eq(insightRecommendations.elderId, elderId),
            inArray(insightRecommendations.status, ['active', 'accepted'])
          )
        )
        .orderBy(desc(insightRecommendations.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    ]);

    const fallback = await this.rollingFallback(elderId, dateKey);
    const insufficient = isInsufficientConfidence(daily.confidence, daily.dataSufficiency);

    const summary: DailyDigestSummary = {
      elderId,
      dateKey,
      scoreBand: insufficient && fallback ? fallback.scoreBand : daily.scoreBand,
      confidence: insufficient && fallback ? fallback.confidence : daily.confidence,
      dataSufficiency: insufficient && fallback ? fallback.dataSufficiency : daily.dataSufficiency,
      insufficientConfidence: insufficient,
      hasConversationData: true,
      insightsPending: false,
      insightState: insufficient ? 'low_confidence' : 'ready',
      lastComputedAt: daily.lastComputedAt.toISOString(),
      topTopics: this.topicScoresFromMetrics((daily.metricsJson ?? {}) as Record<string, unknown>),
      topConcern: topConcern
        ? {
            id: topConcern.id,
            type: topConcern.type,
            severity: topConcern.severity,
            confidence: topConcern.confidence,
            message: topConcern.message
          }
        : null,
      recommendedAction: recommendedAction
        ? {
            id: recommendedAction.id,
            title: recommendedAction.title,
            why: recommendedAction.whyText,
            actionText: recommendedAction.actionText,
            confidence: recommendedAction.confidence,
            status: recommendedAction.status
          }
        : null,
      generatedAt: new Date().toISOString()
    };

    await db
      .insert(insightDailyDigests)
      .values({
        elderId,
        dateKey,
        summaryJson: summary,
        scoreBand: summary.scoreBand,
        confidence: summary.confidence,
        dataSufficiency: summary.dataSufficiency,
        generatedAt: new Date(),
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: [insightDailyDigests.elderId, insightDailyDigests.dateKey],
        set: {
          summaryJson: summary,
          scoreBand: summary.scoreBand,
          confidence: summary.confidence,
          dataSufficiency: summary.dataSufficiency,
          updatedAt: new Date()
        }
      });

    return summary;
  }

  async getTodayDigestForUser(userId: string): Promise<DailyDigestSummary | null> {
    const elderId = await this.getElderIdForUser(userId);
    if (!elderId) return null;

    const dateKey = await this.getTodayDateKeyForUser(userId);

    const [existing] = await db
      .select()
      .from(insightDailyDigests)
      .where(and(eq(insightDailyDigests.elderId, elderId), eq(insightDailyDigests.dateKey, dateKey)))
      .limit(1);

    const base = existing ? (existing.summaryJson as unknown as DailyDigestSummary) : await this.materializeDigestByElder(elderId, dateKey);
    if (!base) {
      const state = await this.buildProcessingState(userId, null);
      if (state.insightState === 'no_conversations') return null;
      return {
        elderId,
        dateKey,
        scoreBand: 'watch',
        confidence: 0,
        dataSufficiency: 0,
        insufficientConfidence: true,
        hasConversationData: state.hasConversationData,
        insightsPending: state.insightsPending,
        insightState: state.insightState,
        lastComputedAt: null,
        topTopics: [],
        topConcern: null,
        recommendedAction: null,
        generatedAt: new Date().toISOString()
      };
    }

    const state = await this.buildProcessingState(userId, base);
    return { ...base, ...state };
  }

  async getDigestForUserByDate(userId: string, dateKey: string): Promise<DailyDigestSummary | null> {
    const elderId = await this.getElderIdForUser(userId);
    if (!elderId) return null;

    const [existing] = await db
      .select()
      .from(insightDailyDigests)
      .where(and(eq(insightDailyDigests.elderId, elderId), eq(insightDailyDigests.dateKey, dateKey)))
      .limit(1);

    const base = existing ? (existing.summaryJson as unknown as DailyDigestSummary) : await this.materializeDigestByElder(elderId, dateKey);
    if (!base) {
      const state = await this.buildProcessingState(userId, null);
      if (state.insightState === 'no_conversations') return null;
      return {
        elderId,
        dateKey,
        scoreBand: 'watch',
        confidence: 0,
        dataSufficiency: 0,
        insufficientConfidence: true,
        hasConversationData: state.hasConversationData,
        insightsPending: state.insightsPending,
        insightState: state.insightState,
        lastComputedAt: null,
        topTopics: [],
        topConcern: null,
        recommendedAction: null,
        generatedAt: new Date().toISOString()
      };
    }

    const state = await this.buildProcessingState(userId, base);
    return { ...base, ...state };
  }

  async getDigestRangeForUser(userId: string, from: string, to: string): Promise<{
    items: DailyDigestSummary[];
    moodTrend: Array<{ ts: number; score: number; confidence: number }>;
    engagementTrend: Array<{ ts: number; score: number; confidence: number }>;
  }> {
    const elderId = await this.getElderIdForUser(userId);
    if (!elderId) return { items: [], moodTrend: [], engagementTrend: [] };

    const rows = await db
      .select()
      .from(insightDailyScores)
      .where(and(eq(insightDailyScores.elderId, elderId), gte(insightDailyScores.dateKey, from), lte(insightDailyScores.dateKey, to)))
      .orderBy(asc(insightDailyScores.dateKey));

    const existingDigests = await db
      .select()
      .from(insightDailyDigests)
      .where(and(eq(insightDailyDigests.elderId, elderId), gte(insightDailyDigests.dateKey, from), lte(insightDailyDigests.dateKey, to)))
      .orderBy(asc(insightDailyDigests.dateKey));

    const existingByDate = new Map(existingDigests.map((row) => [row.dateKey, row.summaryJson as unknown as DailyDigestSummary]));
    const items: DailyDigestSummary[] = [];

    for (const row of rows) {
      const existing = existingByDate.get(row.dateKey);
      if (existing) {
        items.push(existing);
        continue;
      }
      const generated = await this.materializeDigestByElder(elderId, row.dateKey);
      if (generated) items.push(generated);
    }

    return {
      items,
      moodTrend: rows.map((row) => ({
        ts: dateKeyToEpochMs(row.dateKey),
        score: row.emotionalToneScore / 100,
        confidence: row.confidence / 100
      })),
      engagementTrend: rows.map((row) => ({
        ts: dateKeyToEpochMs(row.dateKey),
        score: row.engagementScore / 100,
        confidence: row.confidence / 100
      }))
    };
  }

  async getRealtimeHomeDigestForUser(userId: string): Promise<{
    scoreBand: 'stable' | 'watch' | 'concern';
    confidence: number;
    dataSufficiency: number;
    insufficientConfidence: boolean;
    hasConversationData: boolean;
    insightsPending: boolean;
    insightState: DailyDigestSummary['insightState'];
    topConcern: DailyDigestSummary['topConcern'];
    recommendedAction: DailyDigestSummary['recommendedAction'];
    lastComputedAt: string | null;
  } | null> {
    const digest = await this.getTodayDigestForUser(userId);
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

  async getUsersDueForDigest(now = new Date()): Promise<Array<{
    userId: string;
    familyId: string;
    timezone: string;
    dateKey: string;
  }>> {
    const rows = await db.execute(sql`
      select p.user_id, p.family_id, p.timezone, p.digest_hour_local, p.digest_minute_local
      from caregiver_notification_preferences p
      where p.digest_enabled = true
    `);

    const due: Array<{ userId: string; familyId: string; timezone: string; dateKey: string }> = [];

    for (const row of rows.rows as Array<Record<string, unknown>>) {
      const tz = String(row.timezone ?? 'Asia/Kolkata');
      const localParts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(now);

      const get = (type: string): number => Number(localParts.find((p) => p.type === type)?.value ?? '0');
      const localHour = get('hour');
      const localMinute = get('minute');

      const targetHour = Number(row.digest_hour_local ?? 20);
      const targetMinute = Number(row.digest_minute_local ?? 30);

      if (localHour !== targetHour || localMinute !== targetMinute) continue;

      const dateKey = `${localParts.find((p) => p.type === 'year')?.value}-${localParts.find((p) => p.type === 'month')?.value}-${
        localParts.find((p) => p.type === 'day')?.value
      }`;

      due.push({
        userId: String(row.user_id),
        familyId: String(row.family_id),
        timezone: tz,
        dateKey
      });
    }

    return due;
  }
}
