import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  alerts,
  careReminders,
  careRoutines,
  concernSignals,
  elderDevices,
  elderProfiles,
  escalationPolicies,
  familyAccounts,
  familyMembers,
  insightSnapshots,
  nudges
} from '../../db/schema.js';
import type {
  AlertStatus,
  CareReminder,
  ConcernSignal,
  ElderProfile,
  ElderStatusSnapshot,
  EscalationPolicy,
  FamilyMember,
  FamilyRole,
  InsightOverviewResponse,
  NudgeDeliveryState,
  NudgePriority
} from './family-types.js';

export interface FamilyAccountRecord {
  id: string;
  createdAt: number;
  ownerUserId: string;
}

export interface DeviceRecord {
  id: string;
  elderId: string;
  serialNumber: string;
  linkedAt: number;
  wifiConnected: boolean;
  firmwareVersion?: string;
}

export interface NudgeRecord {
  id: string;
  elderId: string;
  createdByUserId: string;
  type: 'text' | 'voice';
  text?: string;
  voiceUrl?: string;
  priority: NudgePriority;
  scheduledFor: number;
  deliveryState: NudgeDeliveryState;
  createdAt: number;
  updatedAt: number;
}

export interface AlertRecord {
  id: string;
  elderId: string;
  concernSignalId?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: AlertStatus;
  title: string;
  details: string;
  createdAt: number;
  acknowledgedAt?: number;
  resolvedAt?: number;
  updatedAt: number;
}

export interface RoutineRecord {
  id: string;
  elderId: string;
  key: string;
  title: string;
  enabled: boolean;
  schedule: string;
  updatedAt: number;
}

const toMillis = (value: Date | null | undefined): number | undefined => (value ? value.getTime() : undefined);

const toFamilyAccount = (row: typeof familyAccounts.$inferSelect): FamilyAccountRecord => ({
  id: row.id,
  ownerUserId: row.ownerUserId,
  createdAt: row.createdAt.getTime()
});

const toFamilyMember = (row: typeof familyMembers.$inferSelect): FamilyMember => ({
  id: row.id,
  familyId: row.familyId,
  userId: row.userId,
  role: row.role,
  displayName: row.displayName ?? undefined,
  email: row.email ?? undefined,
  phone: row.phone ?? undefined,
  invitedAt: row.invitedAt.getTime(),
  acceptedAt: toMillis(row.acceptedAt)
});

const toElderProfile = (row: typeof elderProfiles.$inferSelect): ElderProfile => ({
  id: row.id,
  familyId: row.familyId,
  name: row.name,
  ageRange: row.ageRange ?? undefined,
  language: row.language ?? undefined,
  city: row.city ?? undefined,
  timezone: row.timezone ?? undefined,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
});

const toDeviceRecord = (row: typeof elderDevices.$inferSelect): DeviceRecord => ({
  id: row.id,
  elderId: row.elderId,
  serialNumber: row.serialNumber,
  linkedAt: row.linkedAt.getTime(),
  wifiConnected: row.wifiConnected,
  firmwareVersion: row.firmwareVersion ?? undefined
});

const toNudgeRecord = (row: typeof nudges.$inferSelect): NudgeRecord => ({
  id: row.id,
  elderId: row.elderId,
  createdByUserId: row.createdByUserId,
  type: row.type,
  text: row.text ?? undefined,
  voiceUrl: row.voiceUrl ?? undefined,
  priority: row.priority,
  scheduledFor: row.scheduledAt.getTime(),
  deliveryState: row.deliveryState,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
});

const toAlertRecord = (row: typeof alerts.$inferSelect): AlertRecord => ({
  id: row.id,
  elderId: row.elderId,
  concernSignalId: row.concernSignalId ?? undefined,
  severity: row.severity,
  status: row.status,
  title: row.title,
  details: row.details,
  createdAt: row.createdAt.getTime(),
  acknowledgedAt: toMillis(row.acknowledgedAt),
  resolvedAt: toMillis(row.resolvedAt),
  updatedAt: row.updatedAt.getTime()
});

const toCareReminder = (row: typeof careReminders.$inferSelect): CareReminder => ({
  id: row.id,
  elderId: row.elderId,
  title: row.title,
  description: row.description ?? undefined,
  scheduledTime: row.scheduledTime,
  enabled: row.enabled,
  updatedAt: row.updatedAt.getTime()
});

const toRoutineRecord = (row: typeof careRoutines.$inferSelect): RoutineRecord => ({
  id: row.id,
  elderId: row.elderId,
  key: row.key,
  title: row.title,
  enabled: row.enabled,
  schedule: row.schedule,
  updatedAt: row.updatedAt.getTime()
});

const toPolicy = (row: typeof escalationPolicies.$inferSelect): EscalationPolicy => ({
  elderId: row.elderId,
  quietHoursStart: row.quietHoursStart,
  quietHoursEnd: row.quietHoursEnd,
  stage1NudgeDelayMin: row.stage1NudgeDelayMin,
  stage2FamilyAlertDelayMin: row.stage2FamilyAlertDelayMin,
  stage3EmergencyDelayMin: row.stage3EmergencyDelayMin,
  enabledTriggers: row.enabledTriggers as EscalationPolicy['enabledTriggers'],
  updatedAt: row.updatedAt.getTime()
});

const toConcernSignal = (row: typeof concernSignals.$inferSelect): ConcernSignal => ({
  id: row.id,
  elderId: row.elderId,
  type: row.type as ConcernSignal['type'],
  severity: row.severity,
  confidence: row.confidence,
  message: row.message,
  createdAt: row.createdAt.getTime()
});

export class FamilyRepository {
  async getOrCreateFamilyForOwner(userId: string): Promise<FamilyAccountRecord> {
    const existing = await this.getFamilyByUser(userId);
    if (existing) return existing;

    const [created] = await db
      .insert(familyAccounts)
      .values({ ownerUserId: userId })
      .returning();

    await db.insert(familyMembers).values({
      familyId: created.id,
      userId,
      role: 'owner',
      acceptedAt: new Date()
    });

    return toFamilyAccount(created);
  }

  async getFamilyByUser(userId: string): Promise<FamilyAccountRecord | null> {
    const [member] = await db.select().from(familyMembers).where(eq(familyMembers.userId, userId)).limit(1);
    if (!member) return null;
    const [family] = await db.select().from(familyAccounts).where(eq(familyAccounts.id, member.familyId)).limit(1);
    return family ? toFamilyAccount(family) : null;
  }

  async getMemberByUser(userId: string): Promise<FamilyMember | null> {
    const [member] = await db.select().from(familyMembers).where(eq(familyMembers.userId, userId)).limit(1);
    return member ? toFamilyMember(member) : null;
  }

  async getMembersByFamilyId(familyId: string): Promise<FamilyMember[]> {
    const rows = await db.select().from(familyMembers).where(eq(familyMembers.familyId, familyId));
    return rows.map(toFamilyMember);
  }

  async getMembersByOwner(ownerUserId: string): Promise<FamilyMember[]> {
    const family = await this.getOrCreateFamilyForOwner(ownerUserId);
    return this.getMembersByFamilyId(family.id);
  }

  async addMember(ownerUserId: string, member: {
    userId?: string;
    displayName?: string;
    email?: string;
    phone?: string;
    role?: FamilyRole;
  }): Promise<FamilyMember> {
    const family = await this.getOrCreateFamilyForOwner(ownerUserId);
    const [created] = await db
      .insert(familyMembers)
      .values({
        familyId: family.id,
        userId: member.userId ?? randomUUID(),
        role: member.role ?? 'member',
        displayName: member.displayName,
        email: member.email,
        phone: member.phone,
        acceptedAt: new Date()
      })
      .returning();

    return toFamilyMember(created);
  }

  async setMemberRole(memberId: string, role: FamilyRole): Promise<FamilyMember | null> {
    const [updated] = await db
      .update(familyMembers)
      .set({ role })
      .where(eq(familyMembers.id, memberId))
      .returning();

    return updated ? toFamilyMember(updated) : null;
  }

  async removeMember(memberId: string): Promise<boolean> {
    const [removed] = await db.delete(familyMembers).where(eq(familyMembers.id, memberId)).returning({ id: familyMembers.id });
    return Boolean(removed);
  }

  private async getElderByFamilyId(familyId: string): Promise<ElderProfile | null> {
    const [elder] = await db.select().from(elderProfiles).where(eq(elderProfiles.familyId, familyId)).limit(1);
    return elder ? toElderProfile(elder) : null;
  }

  async getElderByOwner(ownerUserId: string): Promise<ElderProfile | null> {
    const family = await this.getOrCreateFamilyForOwner(ownerUserId);
    return this.getElderByFamilyId(family.id);
  }

  async getElderByUser(userId: string): Promise<ElderProfile | null> {
    const family = await this.getFamilyByUser(userId);
    if (!family) return null;
    return this.getElderByFamilyId(family.id);
  }

  async isOwner(userId: string): Promise<boolean> {
    const member = await this.getMemberByUser(userId);
    if (!member) {
      await this.getOrCreateFamilyForOwner(userId);
      return true;
    }
    return member.role === 'owner';
  }

  async upsertElder(ownerUserId: string, elder: {
    name: string;
    ageRange?: string;
    language?: string;
    city?: string;
    timezone?: string;
  }): Promise<ElderProfile> {
    const family = await this.getOrCreateFamilyForOwner(ownerUserId);
    const existing = await this.getElderByFamilyId(family.id);

    if (existing) {
      const [updated] = await db
        .update(elderProfiles)
        .set({
          name: elder.name,
          ageRange: elder.ageRange,
          language: elder.language,
          city: elder.city,
          timezone: elder.timezone,
          updatedAt: new Date()
        })
        .where(eq(elderProfiles.id, existing.id))
        .returning();
      return toElderProfile(updated!);
    }

    const [created] = await db
      .insert(elderProfiles)
      .values({
        familyId: family.id,
        name: elder.name,
        ageRange: elder.ageRange,
        language: elder.language,
        city: elder.city,
        timezone: elder.timezone
      })
      .returning();

    return toElderProfile(created);
  }

  async linkDevice(ownerUserId: string, input: {
    serialNumber: string;
    firmwareVersion?: string;
  }): Promise<DeviceRecord> {
    const elder = await this.getElderByOwner(ownerUserId);
    if (!elder) throw new Error('Elder profile required before linking device');

    const [existing] = await db.select().from(elderDevices).where(eq(elderDevices.elderId, elder.id)).limit(1);
    if (existing) {
      const [updated] = await db
        .update(elderDevices)
        .set({
          serialNumber: input.serialNumber,
          firmwareVersion: input.firmwareVersion ?? existing.firmwareVersion,
          wifiConnected: true,
          linkedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(elderDevices.id, existing.id))
        .returning();
      return toDeviceRecord(updated!);
    }

    const [created] = await db
      .insert(elderDevices)
      .values({
        elderId: elder.id,
        serialNumber: input.serialNumber,
        firmwareVersion: input.firmwareVersion,
        wifiConnected: true,
        linkedAt: new Date(),
        updatedAt: new Date()
      })
      .returning();

    return toDeviceRecord(created);
  }

  async unlinkDevice(ownerUserId: string): Promise<boolean> {
    const elder = await this.getElderByOwner(ownerUserId);
    if (!elder) return false;
    const [removed] = await db.delete(elderDevices).where(eq(elderDevices.elderId, elder.id)).returning({ id: elderDevices.id });
    return Boolean(removed);
  }

  async getDeviceStatus(ownerUserId: string): Promise<{
    elder: ElderProfile | null;
    device: DeviceRecord | null;
    snapshot: ElderStatusSnapshot;
  }> {
    const elder = await this.getElderByUser(ownerUserId);
    const [deviceRow] = elder
      ? await db.select().from(elderDevices).where(eq(elderDevices.elderId, elder.id)).limit(1)
      : [undefined];
    const device = deviceRow ? toDeviceRecord(deviceRow) : null;

    return {
      elder,
      device,
      snapshot: {
        elderId: elder?.id ?? 'unknown',
        onlineState: device ? 'online' : 'offline',
        lastInteractionAt: Date.now() - 15 * 60 * 1000,
        latestMoodScore: 0.72,
        latestEngagementScore: 0.68,
        updatedAt: Date.now()
      }
    };
  }

  async addNudge(ownerUserId: string, input: {
    type: 'text' | 'voice';
    text?: string;
    voiceUrl?: string;
    priority: NudgePriority;
    scheduledFor: number;
  }): Promise<NudgeRecord> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) throw new Error('Elder profile not found');

    const [created] = await db
      .insert(nudges)
      .values({
        elderId: elder.id,
        createdByUserId: ownerUserId,
        type: input.type,
        text: input.text,
        voiceUrl: input.voiceUrl,
        priority: input.priority,
        deliveryState: input.scheduledFor > Date.now() ? 'queued' : 'delivered',
        scheduledAt: new Date(input.scheduledFor),
        updatedAt: new Date()
      })
      .returning();

    return toNudgeRecord(created);
  }

  async getNudges(ownerUserId: string): Promise<NudgeRecord[]> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) return [];

    const rows = await db
      .select()
      .from(nudges)
      .where(eq(nudges.elderId, elder.id))
      .orderBy(desc(nudges.createdAt));

    return rows.map(toNudgeRecord);
  }

  async getNextPendingNudge(userId: string): Promise<NudgeRecord | null> {
    const elder = await this.getElderByUser(userId);
    if (!elder) return null;

    const [row] = await db
      .select()
      .from(nudges)
      .where(
        and(
          eq(nudges.elderId, elder.id),
          inArray(nudges.deliveryState, ['queued', 'delivering', 'delivered']),
          lte(nudges.scheduledAt, new Date())
        )
      )
      .orderBy(asc(nudges.scheduledAt), asc(nudges.createdAt))
      .limit(1);

    return row ? toNudgeRecord(row) : null;
  }

  async acknowledgeNudge(userId: string, nudgeId: string): Promise<NudgeRecord | null> {
    const elder = await this.getElderByUser(userId);
    if (!elder) return null;

    const [updated] = await db
      .update(nudges)
      .set({
        deliveryState: 'acknowledged',
        updatedAt: new Date()
      })
      .where(and(eq(nudges.id, nudgeId), eq(nudges.elderId, elder.id)))
      .returning();

    return updated ? toNudgeRecord(updated) : null;
  }

  async getOrCreatePolicy(ownerUserId: string): Promise<EscalationPolicy> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) throw new Error('Elder profile not found');

    const [existing] = await db.select().from(escalationPolicies).where(eq(escalationPolicies.elderId, elder.id)).limit(1);
    if (existing) return toPolicy(existing);

    const [created] = await db
      .insert(escalationPolicies)
      .values({
        elderId: elder.id,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        stage1NudgeDelayMin: 5,
        stage2FamilyAlertDelayMin: 20,
        stage3EmergencyDelayMin: 60,
        enabledTriggers: ['missed_reminder', 'distress_language', 'inactivity', 'device_offline'],
        updatedAt: new Date()
      })
      .returning();

    return toPolicy(created);
  }

  async updatePolicy(ownerUserId: string, patch: Partial<EscalationPolicy>): Promise<EscalationPolicy> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) throw new Error('Elder profile not found');

    const existing = await this.getOrCreatePolicy(ownerUserId);
    const [updated] = await db
      .update(escalationPolicies)
      .set({
        quietHoursStart: patch.quietHoursStart ?? existing.quietHoursStart,
        quietHoursEnd: patch.quietHoursEnd ?? existing.quietHoursEnd,
        stage1NudgeDelayMin: patch.stage1NudgeDelayMin ?? existing.stage1NudgeDelayMin,
        stage2FamilyAlertDelayMin: patch.stage2FamilyAlertDelayMin ?? existing.stage2FamilyAlertDelayMin,
        stage3EmergencyDelayMin: patch.stage3EmergencyDelayMin ?? existing.stage3EmergencyDelayMin,
        enabledTriggers: patch.enabledTriggers ?? existing.enabledTriggers,
        updatedAt: new Date()
      })
      .where(eq(escalationPolicies.elderId, elder.id))
      .returning();

    return toPolicy(updated!);
  }

  async getAlerts(ownerUserId: string): Promise<AlertRecord[]> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) return [];

    const rows = await db
      .select()
      .from(alerts)
      .where(eq(alerts.elderId, elder.id))
      .orderBy(desc(alerts.createdAt));

    return rows.map(toAlertRecord);
  }

  async createAlert(ownerUserId: string, alert: {
    severity: AlertRecord['severity'];
    title: string;
    details: string;
    concernSignalId?: string;
  }): Promise<AlertRecord> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) throw new Error('Elder profile not found');

    const [created] = await db
      .insert(alerts)
      .values({
        elderId: elder.id,
        concernSignalId: alert.concernSignalId,
        severity: alert.severity,
        status: 'open',
        title: alert.title,
        details: alert.details,
        updatedAt: new Date()
      })
      .returning();

    return toAlertRecord(created);
  }

  async updateAlertStatus(alertId: string, status: AlertStatus): Promise<AlertRecord | null> {
    const patch: Partial<typeof alerts.$inferInsert> = {
      status,
      updatedAt: new Date()
    };

    if (status === 'acknowledged') patch.acknowledgedAt = new Date();
    if (status === 'resolved') patch.resolvedAt = new Date();

    const [updated] = await db
      .update(alerts)
      .set(patch)
      .where(eq(alerts.id, alertId))
      .returning();

    return updated ? toAlertRecord(updated) : null;
  }

  async getConcerns(ownerUserId: string): Promise<ConcernSignal[]> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) return [];

    const rows = await db
      .select()
      .from(concernSignals)
      .where(eq(concernSignals.elderId, elder.id))
      .orderBy(desc(concernSignals.createdAt));

    return rows.map(toConcernSignal);
  }

  async ensureSyntheticInsights(ownerUserId: string): Promise<InsightOverviewResponse> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) throw new Error('Elder profile not found');

    const [existing] = await db
      .select()
      .from(insightSnapshots)
      .where(eq(insightSnapshots.elderId, elder.id))
      .orderBy(desc(insightSnapshots.ts))
      .limit(1);

    if (existing) {
      return existing.payload as unknown as InsightOverviewResponse;
    }

    const generated: InsightOverviewResponse = {
      elderId: elder.id,
      generatedAt: Date.now(),
      moodTrend: Array.from({ length: 7 }, (_, idx) => ({
        ts: Date.now() - (6 - idx) * 24 * 60 * 60 * 1000,
        score: Math.max(0, Math.min(1, 0.55 + idx * 0.03))
      })),
      engagementTrend: Array.from({ length: 7 }, (_, idx) => ({
        ts: Date.now() - (6 - idx) * 24 * 60 * 60 * 1000,
        score: Math.max(0, Math.min(1, 0.48 + idx * 0.04))
      })),
      concernSignals: [],
      keyTopics: [
        { topic: 'spiritual_reflection', score: 0.81 },
        { topic: 'family_connection', score: 0.74 },
        { topic: 'health_routine', score: 0.62 }
      ],
      recommendations: [
        {
          id: randomUUID(),
          title: 'Send a warm evening nudge',
          action: 'Ask about today’s satsang reflection in one line.',
          confidence: 'high'
        },
        {
          id: randomUUID(),
          title: 'Reinforce medication routine',
          action: 'Add a 7:30 PM gentle reminder for this week.',
          confidence: 'medium'
        }
      ]
    };

    await db.insert(insightSnapshots).values({
      elderId: elder.id,
      payload: generated as unknown as Record<string, unknown>,
      ts: new Date()
    });

    return generated;
  }

  async getOrCreateRoutines(ownerUserId: string): Promise<RoutineRecord[]> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) return [];

    const existing = await db.select().from(careRoutines).where(eq(careRoutines.elderId, elder.id));
    if (existing.length > 0) return existing.map(toRoutineRecord);

    const rows = await db
      .insert(careRoutines)
      .values([
        {
          elderId: elder.id,
          key: 'morning_brief',
          title: 'Morning Brief',
          enabled: true,
          schedule: '08:00',
          updatedAt: new Date()
        },
        {
          elderId: elder.id,
          key: 'evening_satsang',
          title: 'Evening Satsang',
          enabled: true,
          schedule: '19:30',
          updatedAt: new Date()
        }
      ])
      .returning();

    return rows.map(toRoutineRecord);
  }

  async patchRoutine(ownerUserId: string, routineId: string, patch: Partial<RoutineRecord>): Promise<RoutineRecord | null> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) return null;

    const [updated] = await db
      .update(careRoutines)
      .set({
        title: patch.title,
        enabled: patch.enabled,
        schedule: patch.schedule,
        updatedAt: new Date()
      })
      .where(and(eq(careRoutines.id, routineId), eq(careRoutines.elderId, elder.id)))
      .returning();

    return updated ? toRoutineRecord(updated) : null;
  }

  async getCareReminders(userId: string): Promise<CareReminder[]> {
    const elder = await this.getElderByUser(userId);
    if (!elder) return [];

    const rows = await db
      .select()
      .from(careReminders)
      .where(eq(careReminders.elderId, elder.id));

    return rows.map(toCareReminder).sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
  }

  async createCareReminder(
    userId: string,
    reminder: { title: string; description?: string; scheduledTime: string; enabled?: boolean }
  ): Promise<CareReminder> {
    const elder = await this.getElderByUser(userId);
    if (!elder) throw new Error('Elder profile not found');

    const [created] = await db
      .insert(careReminders)
      .values({
        elderId: elder.id,
        title: reminder.title,
        description: reminder.description,
        scheduledTime: reminder.scheduledTime,
        enabled: reminder.enabled ?? true,
        updatedAt: new Date()
      })
      .returning();

    return toCareReminder(created);
  }

  async patchCareReminder(
    userId: string,
    reminderId: string,
    patch: Partial<Pick<CareReminder, 'title' | 'description' | 'scheduledTime' | 'enabled'>>
  ): Promise<CareReminder | null> {
    const elder = await this.getElderByUser(userId);
    if (!elder) return null;

    const [updated] = await db
      .update(careReminders)
      .set({
        title: patch.title,
        description: patch.description,
        scheduledTime: patch.scheduledTime,
        enabled: patch.enabled,
        updatedAt: new Date()
      })
      .where(and(eq(careReminders.id, reminderId), eq(careReminders.elderId, elder.id)))
      .returning();

    return updated ? toCareReminder(updated) : null;
  }

  async deleteCareReminder(userId: string, reminderId: string): Promise<boolean> {
    const elder = await this.getElderByUser(userId);
    if (!elder) return false;

    const [deletedRow] = await db
      .delete(careReminders)
      .where(and(eq(careReminders.id, reminderId), eq(careReminders.elderId, elder.id)))
      .returning({ id: careReminders.id });

    return Boolean(deletedRow);
  }
}

let sharedRepo: FamilyRepository | null = null;
export const getFamilyRepository = (): FamilyRepository => {
  if (!sharedRepo) sharedRepo = new FamilyRepository();
  return sharedRepo;
};
