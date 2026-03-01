import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  caregiverNotificationPreferences,
  caregiverPushTokens,
  digestDeliveryLogs,
  familyMembers,
  insightDailyDigests
} from '../../db/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getFamilyRepository } from '../family/family-repository.js';
import { DailyDigestService } from '../insights/daily-digest-service.js';

export class DigestNotifierService {
  private readonly repo = getFamilyRepository();
  private readonly digests = new DailyDigestService();

  async getOrCreatePreferences(userId: string): Promise<Record<string, unknown>> {
    const family = (await this.repo.getFamilyByUser(userId)) ?? (await this.repo.getOrCreateFamilyForOwner(userId));

    const [existing] = await db
      .select()
      .from(caregiverNotificationPreferences)
      .where(eq(caregiverNotificationPreferences.userId, userId))
      .limit(1);

    if (existing) {
      return {
        digestEnabled: existing.digestEnabled,
        digestHourLocal: existing.digestHourLocal,
        digestMinuteLocal: existing.digestMinuteLocal,
        timezone: existing.timezone,
        realtimeEnabled: existing.realtimeEnabled,
        updatedAt: existing.updatedAt.toISOString()
      };
    }

    const [created] = await db
      .insert(caregiverNotificationPreferences)
      .values({
        userId,
        familyId: family.id,
        digestEnabled: true,
        digestHourLocal: env.DIGEST_DEFAULT_HOUR,
        digestMinuteLocal: env.DIGEST_DEFAULT_MINUTE,
        timezone: 'Asia/Kolkata',
        realtimeEnabled: true,
        updatedAt: new Date()
      })
      .returning();

    return {
      digestEnabled: created.digestEnabled,
      digestHourLocal: created.digestHourLocal,
      digestMinuteLocal: created.digestMinuteLocal,
      timezone: created.timezone,
      realtimeEnabled: created.realtimeEnabled,
      updatedAt: created.updatedAt.toISOString()
    };
  }

  async updatePreferences(
    userId: string,
    patch: {
      digestEnabled?: boolean;
      digestHourLocal?: number;
      digestMinuteLocal?: number;
      timezone?: string;
      realtimeEnabled?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    const current = await this.getOrCreatePreferences(userId);

    const [updated] = await db
      .update(caregiverNotificationPreferences)
      .set({
        digestEnabled: patch.digestEnabled ?? (current.digestEnabled as boolean),
        digestHourLocal: patch.digestHourLocal ?? (current.digestHourLocal as number),
        digestMinuteLocal: patch.digestMinuteLocal ?? (current.digestMinuteLocal as number),
        timezone: patch.timezone ?? (current.timezone as string),
        realtimeEnabled: patch.realtimeEnabled ?? (current.realtimeEnabled as boolean),
        updatedAt: new Date()
      })
      .where(eq(caregiverNotificationPreferences.userId, userId))
      .returning();

    return {
      digestEnabled: updated.digestEnabled,
      digestHourLocal: updated.digestHourLocal,
      digestMinuteLocal: updated.digestMinuteLocal,
      timezone: updated.timezone,
      realtimeEnabled: updated.realtimeEnabled,
      updatedAt: updated.updatedAt.toISOString()
    };
  }

  async registerPushToken(input: {
    userId: string;
    expoPushToken: string;
    platform?: 'ios' | 'android' | 'unknown';
  }): Promise<Record<string, unknown>> {
    const token = input.expoPushToken.trim();
    if (!token) throw new Error('expoPushToken is required');

    const [upserted] = await db
      .insert(caregiverPushTokens)
      .values({
        userId: input.userId,
        expoPushToken: token,
        platform: input.platform ?? 'unknown',
        isActive: true,
        lastSeenAt: new Date(),
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: caregiverPushTokens.expoPushToken,
        set: {
          userId: input.userId,
          platform: input.platform ?? 'unknown',
          isActive: true,
          lastSeenAt: new Date(),
          updatedAt: new Date()
        }
      })
      .returning();

    return {
      id: upserted.id,
      userId: upserted.userId,
      platform: upserted.platform,
      isActive: upserted.isActive,
      lastSeenAt: upserted.lastSeenAt.toISOString()
    };
  }

  async dispatchDueDigests(now = new Date()): Promise<{ dispatched: number; skipped: number }> {
    await this.ensureDefaultsForAllFamilyMembers();
    const dueRecipients = await this.digests.getUsersDueForDigest(now);

    let dispatched = 0;
    let skipped = 0;

    for (const recipient of dueRecipients) {
      const sent = await this.sendDigestToUser(recipient.userId, recipient.dateKey);
      if (sent) dispatched += 1;
      else skipped += 1;
    }

    return { dispatched, skipped };
  }

  async sendDigestToUser(userId: string, dateKey?: string): Promise<boolean> {
    const elder = await this.repo.getElderByUser(userId);
    if (!elder) return false;

    const targetDate = dateKey ?? (await this.digests.getTodayDateKeyForUser(userId));
    const digest = await this.digests.getDigestForUserByDate(userId, targetDate);
    if (!digest) return false;

    const [digestRow] = await db
      .select()
      .from(insightDailyDigests)
      .where(and(eq(insightDailyDigests.elderId, elder.id), eq(insightDailyDigests.dateKey, targetDate)))
      .limit(1);

    if (!digestRow) return false;

    const [alreadyLogged] = await db
      .select()
      .from(digestDeliveryLogs)
      .where(
        and(
          eq(digestDeliveryLogs.digestId, digestRow.id),
          eq(digestDeliveryLogs.userId, userId),
          eq(digestDeliveryLogs.deliveryChannel, 'in_app')
        )
      )
      .limit(1);

    if (!alreadyLogged) {
      await db
        .insert(digestDeliveryLogs)
        .values({
          digestId: digestRow.id,
          userId,
          deliveryChannel: 'in_app',
          status: 'sent'
        })
        .onConflictDoNothing();
    }

    const [alreadyPushed] = await db
      .select()
      .from(digestDeliveryLogs)
      .where(
        and(
          eq(digestDeliveryLogs.digestId, digestRow.id),
          eq(digestDeliveryLogs.userId, userId),
          eq(digestDeliveryLogs.deliveryChannel, 'expo_push'),
          eq(digestDeliveryLogs.status, 'sent')
        )
      )
      .limit(1);

    if (alreadyPushed) return true;

    const tokens = await db
      .select()
      .from(caregiverPushTokens)
      .where(and(eq(caregiverPushTokens.userId, userId), eq(caregiverPushTokens.isActive, true)))
      .orderBy(desc(caregiverPushTokens.updatedAt));

    if (tokens.length === 0) return true;

    if (!env.EXPO_ACCESS_TOKEN) {
      logger.warn('EXPO_ACCESS_TOKEN missing; skipping push digest send', { userId, dateKey: targetDate });
      return true;
    }

    const sentAny = await this.sendExpoPush(tokens.map((token) => token.expoPushToken), {
      title: 'MITR Daily Insight',
      body: this.buildDigestPushBody(digest),
      data: {
        type: 'daily_digest',
        dateKey: digest.dateKey,
        scoreBand: digest.scoreBand,
        confidence: digest.confidence
      }
    });

    await db
      .insert(digestDeliveryLogs)
      .values({
        digestId: digestRow.id,
        userId,
        deliveryChannel: 'expo_push',
        status: sentAny ? 'sent' : 'failed',
        error: sentAny ? null : 'Push send failed'
      })
      .onConflictDoNothing();

    return true;
  }

  private buildDigestPushBody(digest: {
    scoreBand: string;
    confidence: number;
    recommendedAction: { title: string } | null;
  }): string {
    const actionText = digest.recommendedAction?.title
      ? ` Action: ${digest.recommendedAction.title}.`
      : '';
    return `Today: ${digest.scoreBand.toUpperCase()} (${digest.confidence}% confidence).${actionText}`;
  }

  private async sendExpoPush(
    tokens: string[],
    payload: { title: string; body: string; data: Record<string, unknown> }
  ): Promise<boolean> {
    if (tokens.length === 0) return false;

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}`
        },
        body: JSON.stringify(
          tokens.map((to) => ({
            to,
            title: payload.title,
            body: payload.body,
            sound: 'default',
            data: payload.data
          }))
        )
      });

      return response.ok;
    } catch (error) {
      logger.warn('Expo push send failed', {
        error: (error as Error).message,
        tokenCount: tokens.length
      });
      return false;
    }
  }

  async ensureFamilyDefaults(familyId: string): Promise<void> {
    const members = await db.select().from(familyMembers).where(eq(familyMembers.familyId, familyId));

    for (const member of members) {
      const [existing] = await db
        .select()
        .from(caregiverNotificationPreferences)
        .where(eq(caregiverNotificationPreferences.userId, member.userId))
        .limit(1);

      if (existing) continue;

      await db.insert(caregiverNotificationPreferences).values({
        userId: member.userId,
        familyId,
        digestEnabled: true,
        digestHourLocal: env.DIGEST_DEFAULT_HOUR,
        digestMinuteLocal: env.DIGEST_DEFAULT_MINUTE,
        timezone: 'Asia/Kolkata',
        realtimeEnabled: true,
        updatedAt: new Date()
      });
    }
  }

  private async ensureDefaultsForAllFamilyMembers(): Promise<void> {
    const rows = await db
      .select({
        familyId: familyMembers.familyId
      })
      .from(familyMembers);
    const distinctFamilyIds = [...new Set(rows.map((row) => row.familyId))];

    for (const familyId of distinctFamilyIds) {
      await this.ensureFamilyDefaults(familyId);
    }
  }
}
