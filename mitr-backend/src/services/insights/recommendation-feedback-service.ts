import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { insightRecommendationFeedback, insightRecommendations } from '../../db/schema.js';
import { getFamilyRepository } from '../family/family-repository.js';

export type RecommendationFeedbackAction = 'accepted' | 'dismissed' | 'completed';

export class RecommendationFeedbackService {
  private readonly repo = getFamilyRepository();

  async getActiveForUser(userId: string): Promise<Array<Record<string, unknown>>> {
    const elder = await this.repo.getElderByUser(userId);
    if (!elder) return [];

    const rows = await db
      .select()
      .from(insightRecommendations)
      .where(
        and(
          eq(insightRecommendations.elderId, elder.id),
          inArray(insightRecommendations.status, ['active', 'accepted'])
        )
      )
      .orderBy(desc(insightRecommendations.createdAt));

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      why: row.whyText,
      actionText: row.actionText,
      recommendationType: row.recommendationType,
      scoreBand: row.scoreBand,
      confidence: row.confidence,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }));
  }

  async addFeedback(input: {
    userId: string;
    recommendationId: string;
    action: RecommendationFeedbackAction;
    notes?: string;
  }): Promise<Record<string, unknown>> {
    const elder = await this.repo.getElderByUser(input.userId);
    if (!elder) throw new Error('Elder profile not found');

    const [recommendation] = await db
      .select()
      .from(insightRecommendations)
      .where(and(eq(insightRecommendations.id, input.recommendationId), eq(insightRecommendations.elderId, elder.id)))
      .limit(1);

    if (!recommendation) throw new Error('Recommendation not found');

    await db.insert(insightRecommendationFeedback).values({
      recommendationId: recommendation.id,
      elderId: elder.id,
      userId: input.userId,
      action: input.action,
      notes: input.notes
    });

    const nextStatus = input.action;

    const [updated] = await db
      .update(insightRecommendations)
      .set({
        status: nextStatus,
        metadataJson: {
          ...(recommendation.metadataJson as Record<string, unknown>),
          latestFeedbackAction: input.action,
          latestFeedbackAt: new Date().toISOString(),
          latestFeedbackBy: input.userId,
          latestFeedbackNotes: input.notes ?? null,
          cooldownUntil:
            input.action === 'dismissed'
              ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
              : input.action === 'completed'
                ? new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
                : (recommendation.metadataJson as Record<string, unknown> | null)?.cooldownUntil ?? null
        },
        cooldownUntil:
          input.action === 'dismissed'
            ? new Date(Date.now() + 24 * 60 * 60 * 1000)
            : input.action === 'completed'
              ? new Date(Date.now() + 48 * 60 * 60 * 1000)
              : recommendation.cooldownUntil,
        updatedAt: new Date()
      })
      .where(eq(insightRecommendations.id, recommendation.id))
      .returning();

    return {
      id: updated.id,
      status: updated.status,
      recommendationType: updated.recommendationType,
      updatedAt: updated.updatedAt.toISOString()
    };
  }

  async confirmAction(input: {
    userId: string;
    recommendationId: string;
    confirmed: boolean;
  }): Promise<Record<string, unknown>> {
    return this.addFeedback({
      userId: input.userId,
      recommendationId: input.recommendationId,
      action: input.confirmed ? 'accepted' : 'dismissed'
    });
  }

  async getLastFeedbackByType(elderId: string, recommendationType: string): Promise<{
    action: RecommendationFeedbackAction;
    createdAt: Date;
  } | null> {
    const rows = await db.execute(sql`
      select f.action, f.created_at
      from insight_recommendation_feedback f
      join insight_recommendations r on r.id = f.recommendation_id
      where f.elder_id = ${elderId}
        and r.recommendation_type = ${recommendationType}
      order by f.created_at desc
      limit 1
    `);

    const row = (rows.rows as Array<Record<string, unknown>>)[0];
    if (!row) return null;

    return {
      action: row.action as RecommendationFeedbackAction,
      createdAt: new Date(String(row.created_at))
    };
  }
}
