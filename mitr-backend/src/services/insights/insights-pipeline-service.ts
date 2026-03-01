import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  concernSignals,
  insightCheckins,
  insightDailyScores,
  insightEvidenceSpans,
  insightModelVersions,
  insightPipelineRuns,
  insightRecommendations,
  insightSignalEvents,
  insightSnapshots,
  userInputTranscripts
} from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { getFamilyRepository } from '../family/family-repository.js';
import {
  clamp,
  computeDomainScores,
  computeProsodyProxy,
  computeSignalConfidence,
  confidenceToLabel,
  dateKeyToEpochMs,
  extractSignalFeatures,
  scoreBandFromOverall,
  smoothScore,
  toIsoDateKey,
  type ScoreBand
} from './insights-scoring.js';
import type { InsightIngestJobPayload } from './queue.js';

const ACTIVE_MODEL_KEY = 'wellness_v1';
const ACTIVE_MODEL_VERSION = '2026.02.research.v1';

type DailyAggregate = {
  id: string;
  elderId: string;
  dateKey: string;
  engagementScore: number;
  emotionalToneScore: number;
  socialConnectionScore: number;
  adherenceScore: number;
  distressScore: number;
  overallScore: number;
  scoreBand: ScoreBand;
  confidence: number;
  dataSufficiency: number;
  lastComputedAt: Date;
};

const toNumber = (value: number): number => clamp(Number.isFinite(value) ? value : 0);

const average = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const normalizeTranscript = (transcript: string, language?: string | null): {
  normalizedText: string;
  normalizedLanguage: string;
  normalizationConfidence: number;
  translationApplied: boolean;
} => {
  const normalizedText = transcript.trim();
  if (!normalizedText) {
    return {
      normalizedText,
      normalizedLanguage: 'en',
      normalizationConfidence: 0,
      translationApplied: false
    };
  }

  const lang = (language ?? '').toLowerCase();
  if (!lang || lang.startsWith('en')) {
    return {
      normalizedText,
      normalizedLanguage: 'en',
      normalizationConfidence: 95,
      translationApplied: false
    };
  }

  const isIndicScript = /[\u0900-\u097F\u0600-\u06FF]/.test(normalizedText);

  return {
    normalizedText,
    normalizedLanguage: 'en',
    normalizationConfidence: isIndicScript ? 62 : 74,
    translationApplied: false
  };
};

const concernSeverityFromScore = (score: number): 'low' | 'medium' | 'high' | 'critical' => {
  if (score >= 90) return 'critical';
  if (score >= 75) return 'high';
  if (score >= 55) return 'medium';
  return 'low';
};

const buildRecommendationAction = (type: string): { title: string; whyText: string; actionText: string } => {
  switch (type) {
    case 'family_connect':
      return {
        title: 'Strengthen family connection today',
        whyText: 'Recent interactions show low social-connection cues this week.',
        actionText: 'Send a gentle family nudge asking one warm personal question.'
      };
    case 'adherence_support':
      return {
        title: 'Reinforce medicine and routine adherence',
        whyText: 'Conversation cues suggest routine follow-through may be slipping.',
        actionText: 'Add one simple medication reminder and confirm timing with elder.'
      };
    case 'engagement_boost':
      return {
        title: 'Boost engagement with a short guided check-in',
        whyText: 'Turn depth and interaction quality dropped below recent baseline.',
        actionText: 'Start a 5-minute check-in focused on one meaningful daily topic.'
      };
    case 'distress_followup':
      return {
        title: 'Follow up on distress cues with care',
        whyText: 'Language includes elevated distress indicators at meaningful confidence.',
        actionText: 'Send a calm reassuring nudge now and review escalation policy settings.'
      };
    default:
      return {
        title: 'Continue supportive engagement',
        whyText: 'Maintain routine caregiver contact to keep stability.',
        actionText: 'Send a warm nudge and ask one short wellbeing question.'
      };
  }
};

export class InsightsPipelineService {
  private readonly repo = getFamilyRepository();

  async processTranscriptJob(payload: InsightIngestJobPayload): Promise<void> {
    const startedAt = new Date();
    const transcribedAt = Number.isFinite(Date.parse(payload.transcribedAtIso))
      ? new Date(payload.transcribedAtIso)
      : new Date();
    const queueLagMs = Math.max(0, Date.now() - transcribedAt.getTime());

    const [run] = await db
      .insert(insightPipelineRuns)
      .values({
        userId: payload.userId,
        runType: 'transcript_ingest',
        status: 'started',
        queueLagMs,
        metadataJson: {
          transcriptId: payload.transcriptId,
          sessionId: payload.sessionId
        },
        startedAt
      })
      .returning({ id: insightPipelineRuns.id });

    try {
      await this.ensureModelVersion();

      const elder = await this.repo.getElderByUser(payload.userId);
      if (!elder) {
        await this.completeRun(run.id, {
          status: 'completed',
          metadataJson: {
            skipped: true,
            reason: 'elder_not_linked'
          }
        });
        return;
      }

      const timeZone = elder.timezone?.trim() || 'Asia/Kolkata';
      const dateKey = toIsoDateKey(transcribedAt, timeZone);

      const [{ count: priorTurnsRaw }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(insightSignalEvents)
        .where(and(eq(insightSignalEvents.elderId, elder.id), eq(insightSignalEvents.dateKey, dateKey)));

      const normalized = normalizeTranscript(payload.transcript, payload.language);
      const features = extractSignalFeatures(normalized.normalizedText);
      const prosody = computeProsodyProxy(features);
      const domains = computeDomainScores(features);
      const confidenceMetrics = computeSignalConfidence({
        features,
        languageNormalizationConfidence: normalized.normalizationConfidence,
        prosodyCompleteness: prosody.prosodyCompleteness,
        priorTurnsToday: Number(priorTurnsRaw ?? 0)
      });

      const eventBand = scoreBandFromOverall(domains.overallScore);

      const [signalEvent] = await db
        .insert(insightSignalEvents)
        .values({
          elderId: elder.id,
          userId: payload.userId,
          sessionId: payload.sessionId,
          transcriptId: payload.transcriptId,
          dateKey,
          sourceLanguage: payload.language ?? null,
          normalizedLanguage: normalized.normalizedLanguage,
          transcriptOriginal: payload.transcript,
          transcriptNormalized: normalized.normalizedText,
          engagementScore: domains.engagementScore,
          emotionalToneScore: domains.emotionalToneScore,
          socialConnectionScore: domains.socialConnectionScore,
          adherenceScore: domains.adherenceScore,
          distressScore: domains.distressScore,
          overallScore: domains.overallScore,
          scoreBand: eventBand,
          confidence: confidenceMetrics.confidence,
          dataSufficiency: confidenceMetrics.dataSufficiency,
          featuresJson: {
            ...features,
            prosody,
            languageNormalizationConfidence: normalized.normalizationConfidence,
            translationApplied: normalized.translationApplied
          },
          eventTs: transcribedAt
        })
        .returning({
          id: insightSignalEvents.id,
          overallScore: insightSignalEvents.overallScore,
          confidence: insightSignalEvents.confidence,
          dataSufficiency: insightSignalEvents.dataSufficiency
        });

      await db.insert(insightEvidenceSpans).values({
        elderId: elder.id,
        signalEventId: signalEvent.id,
        transcriptId: payload.transcriptId,
        snippet: payload.transcript.slice(0, 260),
        rationale: 'Direct user statement from finalized transcript turn.',
        weight: clamp(45 + features.wordCount),
        eventTs: transcribedAt
      });

      const daily = await this.recomputeDailyAggregate(elder.id, dateKey);
      const concernIds = await this.refreshConcernSignals(elder.id, daily, signalEvent.id, payload.transcriptId, transcribedAt);
      const recommendationIds = await this.refreshRecommendations(
        elder.id,
        dateKey,
        daily,
        signalEvent.id,
        payload.transcriptId,
        transcribedAt
      );

      await this.rebuildSnapshot(elder.id);

      await this.completeRun(run.id, {
        elderId: elder.id,
        status: 'completed',
        metadataJson: {
          scoreBand: daily.scoreBand,
          confidence: daily.confidence,
          dataSufficiency: daily.dataSufficiency,
          concernsCreated: concernIds.length,
          recommendationsCreated: recommendationIds.length,
          signalEventId: signalEvent.id
        }
      });
    } catch (error) {
      await this.completeRun(run.id, {
        status: 'failed',
        errorMessage: (error as Error).message,
        metadataJson: {
          transcriptId: payload.transcriptId,
          sessionId: payload.sessionId
        }
      });
      logger.error('Insights pipeline transcript job failed', {
        transcriptId: payload.transcriptId,
        sessionId: payload.sessionId,
        userId: payload.userId,
        error: (error as Error).message
      });
      throw error;
    }
  }

  async addCheckin(input: {
    userId: string;
    moodLabel: 'better' | 'same' | 'worse';
    engagementLabel: 'better' | 'same' | 'worse';
    socialLabel: 'better' | 'same' | 'worse';
    concernLevel?: 'none' | 'low' | 'medium' | 'high';
    notes?: string;
    weekStartDate?: string;
  }): Promise<{ id: string; elderId: string; createdAt: string }> {
    const elder = await this.repo.getElderByUser(input.userId);
    if (!elder) throw new Error('Elder profile not found');

    const weekStartDate = input.weekStartDate ?? toIsoDateKey(new Date());

    const [created] = await db
      .insert(insightCheckins)
      .values({
        elderId: elder.id,
        createdByUserId: input.userId,
        weekStartDate,
        moodLabel: input.moodLabel,
        engagementLabel: input.engagementLabel,
        socialLabel: input.socialLabel,
        concernLevel: input.concernLevel ?? 'none',
        notes: input.notes
      })
      .returning({
        id: insightCheckins.id,
        elderId: insightCheckins.elderId,
        createdAt: insightCheckins.createdAt
      });

    await this.rebuildSnapshot(elder.id);

    return {
      id: created.id,
      elderId: created.elderId,
      createdAt: created.createdAt.toISOString()
    };
  }

  private async ensureModelVersion(): Promise<void> {
    const [active] = await db
      .select()
      .from(insightModelVersions)
      .where(and(eq(insightModelVersions.key, ACTIVE_MODEL_KEY), eq(insightModelVersions.isActive, true)))
      .limit(1);

    if (active) return;

    await db.insert(insightModelVersions).values({
      key: ACTIVE_MODEL_KEY,
      version: ACTIVE_MODEL_VERSION,
      isActive: true,
      configJson: {
        weights: {
          engagement: 0.3,
          emotionalTone: 0.25,
          socialConnection: 0.2,
          adherence: 0.15,
          distressResidual: 0.1
        },
        outputPolicy: {
          suppressRecommendationsBelowConfidence: 45,
          confidenceBanding: 'low-medium-high'
        },
        safety: 'wellness_only_non_diagnostic'
      }
    });
  }

  private async recomputeDailyAggregate(elderId: string, dateKey: string): Promise<DailyAggregate> {
    const rows = await db
      .select()
      .from(insightSignalEvents)
      .where(and(eq(insightSignalEvents.elderId, elderId), eq(insightSignalEvents.dateKey, dateKey)))
      .orderBy(asc(insightSignalEvents.eventTs));

    const [previousDay] = await db
      .select()
      .from(insightDailyScores)
      .where(and(eq(insightDailyScores.elderId, elderId), lt(insightDailyScores.dateKey, dateKey)))
      .orderBy(desc(insightDailyScores.dateKey))
      .limit(1);

    const engagementRaw = average(rows.map((row) => row.engagementScore));
    const emotionalRaw = average(rows.map((row) => row.emotionalToneScore));
    const socialRaw = average(rows.map((row) => row.socialConnectionScore));
    const adherenceRaw = average(rows.map((row) => row.adherenceScore));
    const distressRaw = average(rows.map((row) => row.distressScore));
    const overallRaw = average(rows.map((row) => row.overallScore));
    const confidenceRaw = average(rows.map((row) => row.confidence));
    const dataSufficiencyRaw = average(rows.map((row) => row.dataSufficiency));

    const engagementScore = smoothScore(engagementRaw, previousDay?.engagementScore);
    const emotionalToneScore = smoothScore(emotionalRaw, previousDay?.emotionalToneScore);
    const socialConnectionScore = smoothScore(socialRaw, previousDay?.socialConnectionScore);
    const adherenceScore = smoothScore(adherenceRaw, previousDay?.adherenceScore);
    const distressScore = smoothScore(distressRaw, previousDay?.distressScore);
    const overallScore = smoothScore(overallRaw, previousDay?.overallScore);

    const confidence = toNumber(confidenceRaw);
    const dataSufficiency = toNumber(dataSufficiencyRaw);
    const scoreBand = scoreBandFromOverall(overallScore);

    const topicCounts: Record<string, number> = {};
    for (const row of rows) {
      const rowTopicCounts = (row.featuresJson as { topicCounts?: Record<string, number> } | null)?.topicCounts ?? {};
      for (const [topic, count] of Object.entries(rowTopicCounts)) {
        topicCounts[topic] = (topicCounts[topic] ?? 0) + count;
      }
    }

    const [upserted] = await db
      .insert(insightDailyScores)
      .values({
        elderId,
        dateKey,
        engagementScore,
        emotionalToneScore,
        socialConnectionScore,
        adherenceScore,
        distressScore,
        overallScore,
        scoreBand,
        confidence,
        dataSufficiency,
        metricsJson: {
          sampleCount: rows.length,
          topicCounts
        },
        lastComputedAt: new Date(),
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: [insightDailyScores.elderId, insightDailyScores.dateKey],
        set: {
          engagementScore,
          emotionalToneScore,
          socialConnectionScore,
          adherenceScore,
          distressScore,
          overallScore,
          scoreBand,
          confidence,
          dataSufficiency,
          metricsJson: {
            sampleCount: rows.length,
            topicCounts
          },
          lastComputedAt: new Date(),
          updatedAt: new Date()
        }
      })
      .returning();

    return {
      id: upserted.id,
      elderId: upserted.elderId,
      dateKey: upserted.dateKey,
      engagementScore: upserted.engagementScore,
      emotionalToneScore: upserted.emotionalToneScore,
      socialConnectionScore: upserted.socialConnectionScore,
      adherenceScore: upserted.adherenceScore,
      distressScore: upserted.distressScore,
      overallScore: upserted.overallScore,
      scoreBand: upserted.scoreBand,
      confidence: upserted.confidence,
      dataSufficiency: upserted.dataSufficiency,
      lastComputedAt: upserted.lastComputedAt
    };
  }

  private async refreshConcernSignals(
    elderId: string,
    daily: DailyAggregate,
    signalEventId: string,
    transcriptId: string,
    eventTs: Date
  ): Promise<string[]> {
    const createdIds: string[] = [];

    const candidates: Array<{ type: 'distress_language' | 'inactivity' | 'missed_medication'; trigger: boolean; score: number; message: string }> = [
      {
        type: 'distress_language',
        trigger: daily.distressScore >= 70 && daily.confidence >= 50,
        score: daily.distressScore,
        message: 'Distress-related language increased in recent interactions.'
      },
      {
        type: 'inactivity',
        trigger: daily.engagementScore < 38 && daily.confidence >= 45,
        score: 100 - daily.engagementScore,
        message: 'Engagement quality dropped below expected range.'
      },
      {
        type: 'missed_medication',
        trigger: daily.adherenceScore < 35 && daily.confidence >= 45,
        score: 100 - daily.adherenceScore,
        message: 'Care adherence cues indicate possible missed routine steps.'
      }
    ];

    for (const candidate of candidates) {
      if (!candidate.trigger) continue;

      const [existingOpen] = await db
        .select({ id: concernSignals.id })
        .from(concernSignals)
        .where(
          and(
            eq(concernSignals.elderId, elderId),
            eq(concernSignals.type, candidate.type),
            eq(concernSignals.status, 'open')
          )
        )
        .limit(1);

      if (existingOpen) continue;

      const [created] = await db
        .insert(concernSignals)
        .values({
          elderId,
          type: candidate.type,
          severity: concernSeverityFromScore(candidate.score),
          confidence: confidenceToLabel(daily.confidence),
          message: candidate.message,
          status: 'open'
        })
        .returning({ id: concernSignals.id });

      createdIds.push(created.id);

      await db.insert(insightEvidenceSpans).values({
        elderId,
        signalEventId,
        concernSignalId: created.id,
        transcriptId,
        snippet: candidate.message,
        rationale: 'Concern triggered by daily threshold and confidence condition.',
        weight: clamp(candidate.score),
        eventTs
      });
    }

    return createdIds;
  }

  private async refreshRecommendations(
    elderId: string,
    dateKey: string,
    daily: DailyAggregate,
    signalEventId: string,
    transcriptId: string,
    eventTs: Date
  ): Promise<string[]> {
    if (daily.confidence < 40) return [];

    const rules: Array<{ type: string; enabled: boolean }> = [
      { type: 'distress_followup', enabled: daily.distressScore >= 68 && daily.confidence >= 50 },
      { type: 'engagement_boost', enabled: daily.engagementScore < 45 },
      { type: 'family_connect', enabled: daily.socialConnectionScore < 48 },
      { type: 'adherence_support', enabled: daily.adherenceScore < 50 }
    ];

    const now = new Date();
    const createdIds: string[] = [];

    for (const rule of rules) {
      if (!rule.enabled) continue;

      const [existingActive] = await db
        .select({ id: insightRecommendations.id })
        .from(insightRecommendations)
        .where(
          and(
            eq(insightRecommendations.elderId, elderId),
            eq(insightRecommendations.recommendationType, rule.type),
            eq(insightRecommendations.status, 'active'),
            sql`${insightRecommendations.cooldownUntil} IS NULL OR ${insightRecommendations.cooldownUntil} > now()`
          )
        )
        .limit(1);

      if (existingActive) continue;

      const recommendation = buildRecommendationAction(rule.type);

      const [created] = await db
        .insert(insightRecommendations)
        .values({
          elderId,
          dateKey,
          recommendationType: rule.type,
          title: recommendation.title,
          whyText: recommendation.whyText,
          actionText: recommendation.actionText,
          status: 'active',
          scoreBand: daily.scoreBand,
          confidence: daily.confidence,
          cooldownUntil: new Date(now.getTime() + 18 * 60 * 60 * 1000),
          metadataJson: {
            dailyScoreId: daily.id,
            source: 'insights_pipeline_rule'
          }
        })
        .returning({ id: insightRecommendations.id });

      createdIds.push(created.id);

      await db.insert(insightEvidenceSpans).values({
        elderId,
        signalEventId,
        recommendationId: created.id,
        transcriptId,
        snippet: recommendation.whyText,
        rationale: 'Recommendation generated from score + confidence rule.',
        weight: clamp(daily.confidence),
        eventTs
      });
    }

    return createdIds;
  }

  async rebuildSnapshot(elderId: string): Promise<void> {
    const dailyRows = await db
      .select()
      .from(insightDailyScores)
      .where(eq(insightDailyScores.elderId, elderId))
      .orderBy(asc(insightDailyScores.dateKey));

    const recentDaily = dailyRows.slice(-30);
    const moodTrend = recentDaily.map((row) => ({
      ts: dateKeyToEpochMs(row.dateKey),
      score: clamp(row.emotionalToneScore) / 100
    }));

    const engagementTrend = recentDaily.map((row) => ({
      ts: dateKeyToEpochMs(row.dateKey),
      score: clamp(row.engagementScore) / 100
    }));

    const [openConcerns, activeRecommendations, recentSignals, evidenceCountRows] = await Promise.all([
      db
        .select()
        .from(concernSignals)
        .where(and(eq(concernSignals.elderId, elderId), eq(concernSignals.status, 'open')))
        .orderBy(desc(concernSignals.createdAt))
        .limit(8),
      db
        .select()
        .from(insightRecommendations)
        .where(and(eq(insightRecommendations.elderId, elderId), eq(insightRecommendations.status, 'active')))
        .orderBy(desc(insightRecommendations.createdAt))
        .limit(6),
      db
        .select()
        .from(insightSignalEvents)
        .where(eq(insightSignalEvents.elderId, elderId))
        .orderBy(desc(insightSignalEvents.eventTs))
        .limit(200),
      db
        .select({ count: sql<number>`count(*)` })
        .from(insightEvidenceSpans)
        .where(eq(insightEvidenceSpans.elderId, elderId))
    ]);

    const topicTotals: Record<string, number> = {};
    for (const row of recentSignals) {
      const topicCounts = (row.featuresJson as { topicCounts?: Record<string, number> } | null)?.topicCounts ?? {};
      for (const [topic, count] of Object.entries(topicCounts)) {
        topicTotals[topic] = (topicTotals[topic] ?? 0) + count;
      }
    }

    const maxTopic = Math.max(1, ...Object.values(topicTotals));
    const keyTopics = Object.entries(topicTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([topic, count]) => ({ topic, score: clamp((count / maxTopic) * 100) / 100 }));

    const latest = recentDaily.at(-1);

    const snapshotPayload = {
      elderId,
      generatedAt: Date.now(),
      moodTrend,
      engagementTrend,
      concernSignals: openConcerns.map((row) => ({
        id: row.id,
        elderId: row.elderId,
        type: row.type,
        severity: row.severity,
        confidence: row.confidence,
        message: row.message,
        createdAt: row.createdAt.getTime()
      })),
      keyTopics,
      recommendations: activeRecommendations.map((row) => ({
        id: row.id,
        title: row.title,
        action: row.actionText,
        why: row.whyText,
        confidence: confidenceToLabel(row.confidence)
      })),
      scoreBand: latest?.scoreBand ?? 'watch',
      confidence: latest?.confidence ?? 0,
      dataSufficiency: latest?.dataSufficiency ?? 0,
      evidenceCount: Number(evidenceCountRows[0]?.count ?? 0),
      lastComputedAt: latest?.lastComputedAt?.toISOString() ?? null
    };

    await db.insert(insightSnapshots).values({
      elderId,
      ts: new Date(),
      payload: snapshotPayload
    });
  }

  private async completeRun(
    runId: string,
    input: {
      elderId?: string;
      status: 'completed' | 'failed';
      errorMessage?: string;
      metadataJson?: Record<string, unknown>;
    }
  ): Promise<void> {
    await db
      .update(insightPipelineRuns)
      .set({
        elderId: input.elderId,
        status: input.status,
        errorMessage: input.errorMessage,
        metadataJson: input.metadataJson ?? {},
        endedAt: new Date()
      })
      .where(eq(insightPipelineRuns.id, runId));
  }
}

export type InsightsExplanationItem = {
  id: string;
  snippet: string;
  rationale: string;
  weight: number;
  createdAt: string;
};

export class InsightsReadService {
  private readonly repo = getFamilyRepository();

  async overview(userId: string): Promise<Record<string, unknown>> {
    const elder = await this.repo.getElderByUser(userId);
    if (!elder) {
      return {
        elderId: null,
        generatedAt: Date.now(),
        scoreBand: 'watch',
        confidence: 0,
        dataSufficiency: 0,
        evidenceCount: 0,
        lastComputedAt: null,
        moodTrend: [],
        engagementTrend: [],
        concernSignals: [],
        keyTopics: [],
        recommendations: []
      };
    }

    const [latestSnapshot] = await db
      .select()
      .from(insightSnapshots)
      .where(eq(insightSnapshots.elderId, elder.id))
      .orderBy(desc(insightSnapshots.ts))
      .limit(1);

    if (!latestSnapshot) {
      const pipeline = new InsightsPipelineService();
      await pipeline.rebuildSnapshot(elder.id);
      const [rebuilt] = await db
        .select()
        .from(insightSnapshots)
        .where(eq(insightSnapshots.elderId, elder.id))
        .orderBy(desc(insightSnapshots.ts))
        .limit(1);
      return (rebuilt?.payload as Record<string, unknown>) ?? {};
    }

    return latestSnapshot.payload as Record<string, unknown>;
  }

  async timeline(userId: string, range: '24h' | '7d' | '30d'): Promise<Record<string, unknown>> {
    const elder = await this.repo.getElderByUser(userId);
    if (!elder) {
      return {
        range,
        moodTrend: [],
        engagementTrend: [],
        confidenceBand: []
      };
    }

    const days = range === '24h' ? 1 : range === '7d' ? 7 : 30;
    const today = toIsoDateKey(new Date());
    const cutoffDate = new Date(`${today}T00:00:00+05:30`);
    cutoffDate.setDate(cutoffDate.getDate() - (days - 1));
    const cutoffKey = toIsoDateKey(cutoffDate);

    const rows = await db
      .select()
      .from(insightDailyScores)
      .where(and(eq(insightDailyScores.elderId, elder.id), gte(insightDailyScores.dateKey, cutoffKey)))
      .orderBy(asc(insightDailyScores.dateKey));

    return {
      range,
      moodTrend: rows.map((row) => ({ ts: dateKeyToEpochMs(row.dateKey), score: row.emotionalToneScore / 100 })),
      engagementTrend: rows.map((row) => ({ ts: dateKeyToEpochMs(row.dateKey), score: row.engagementScore / 100 })),
      confidenceBand: rows.map((row) => ({ ts: dateKeyToEpochMs(row.dateKey), confidence: row.confidence / 100 }))
    };
  }

  async topics(userId: string, range: '7d' | '30d'): Promise<Record<string, unknown>> {
    const elder = await this.repo.getElderByUser(userId);
    if (!elder) return { range, topics: [] };

    const days = range === '7d' ? 7 : 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days + 1);
    const cutoffKey = toIsoDateKey(cutoffDate);

    const rows = await db
      .select({ featuresJson: insightSignalEvents.featuresJson })
      .from(insightSignalEvents)
      .where(and(eq(insightSignalEvents.elderId, elder.id), gte(insightSignalEvents.dateKey, cutoffKey)));

    const topicTotals: Record<string, number> = {};
    for (const row of rows) {
      const counts = (row.featuresJson as { topicCounts?: Record<string, number> } | null)?.topicCounts ?? {};
      for (const [topic, count] of Object.entries(counts)) {
        topicTotals[topic] = (topicTotals[topic] ?? 0) + count;
      }
    }

    const maxTopic = Math.max(1, ...Object.values(topicTotals));

    return {
      range,
      topics: Object.entries(topicTotals)
        .sort((a, b) => b[1] - a[1])
        .map(([topic, score]) => ({ topic, score: clamp((score / maxTopic) * 100) / 100 }))
    };
  }

  async concerns(userId: string, status: 'open' | 'all'): Promise<Array<Record<string, unknown>>> {
    const elder = await this.repo.getElderByUser(userId);
    if (!elder) return [];

    const rows = await db
      .select()
      .from(concernSignals)
      .where(
        status === 'all'
          ? eq(concernSignals.elderId, elder.id)
          : and(eq(concernSignals.elderId, elder.id), eq(concernSignals.status, 'open'))
      )
      .orderBy(desc(concernSignals.createdAt));

    return rows.map((row) => ({
      id: row.id,
      elderId: row.elderId,
      type: row.type,
      severity: row.severity,
      confidence: row.confidence,
      message: row.message,
      status: row.status,
      createdAt: row.createdAt.toISOString()
    }));
  }

  async sessions(userId: string, cursor?: string): Promise<Record<string, unknown>> {
    const elder = await this.repo.getElderByUser(userId);
    if (!elder) return { cursor: cursor ?? null, nextCursor: null, items: [] };

    const limit = 20;
    const rows = await db
      .select()
      .from(insightSignalEvents)
      .where(eq(insightSignalEvents.elderId, elder.id))
      .orderBy(desc(insightSignalEvents.eventTs))
      .limit(limit);

    return {
      cursor: cursor ?? null,
      nextCursor: null,
      items: rows.map((row) => ({
        id: row.id,
        ts: row.eventTs.toISOString(),
        summary: row.transcriptOriginal.slice(0, 220),
        scoreBand: row.scoreBand,
        confidence: confidenceToLabel(row.confidence)
      }))
    };
  }

  async explanations(userId: string, signalId: string): Promise<{
    signalId: string;
    items: InsightsExplanationItem[];
  }> {
    const elder = await this.repo.getElderByUser(userId);
    if (!elder) return { signalId, items: [] };

    const rows = await db
      .select()
      .from(insightEvidenceSpans)
      .where(
        and(
          eq(insightEvidenceSpans.elderId, elder.id),
          sql`${insightEvidenceSpans.signalEventId} = ${signalId} OR ${insightEvidenceSpans.recommendationId} = ${signalId} OR ${
            insightEvidenceSpans.concernSignalId
          } = ${signalId}`
        )
      )
      .orderBy(desc(insightEvidenceSpans.createdAt))
      .limit(10);

    return {
      signalId,
      items: rows.map((row) => ({
        id: row.id,
        snippet: row.snippet,
        rationale: row.rationale,
        weight: row.weight,
        createdAt: row.createdAt.toISOString()
      }))
    };
  }

  async pipelineHealth(userId: string): Promise<Record<string, unknown>> {
    const elder = await this.repo.getElderByUser(userId);

    const runs = await db
      .select()
      .from(insightPipelineRuns)
      .where(elder ? eq(insightPipelineRuns.elderId, elder.id) : sql`true`)
      .orderBy(desc(insightPipelineRuns.startedAt))
      .limit(20);

    return {
      elderId: elder?.id ?? null,
      recentRuns: runs.map((run) => ({
        id: run.id,
        status: run.status,
        runType: run.runType,
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt?.toISOString() ?? null,
        queueLagMs: run.queueLagMs,
        errorMessage: run.errorMessage
      }))
    };
  }

  async ingestFromTranscriptId(transcriptId: string): Promise<boolean> {
    const [row] = await db
      .select()
      .from(userInputTranscripts)
      .where(eq(userInputTranscripts.id, transcriptId))
      .limit(1);

    if (!row) return false;

    await this.processTranscriptJobFromRow(row);
    return true;
  }

  private async processTranscriptJobFromRow(row: typeof userInputTranscripts.$inferSelect): Promise<void> {
    const pipeline = new InsightsPipelineService();
    await pipeline.processTranscriptJob({
      transcriptId: row.id,
      userId: row.userId,
      sessionId: row.sessionId,
      transcript: row.transcript,
      language: row.language,
      transcribedAtIso: row.createdAt.toISOString()
    });
  }
}
