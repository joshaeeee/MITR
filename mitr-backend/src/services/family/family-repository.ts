import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  alerts,
  carePlanItems,
  careReminders,
  careRoutines,
  concernSignals,
  elderDeviceUsageSessions,
  elderDevices,
  elderProfiles,
  escalationPolicies,
  familyAccounts,
  familyMembers,
  insightDailyScores,
  nudges
} from '../../db/schema.js';
import type {
  AlertStatus,
  CarePlanItem,
  CarePlanSection,
  CarePlanSource,
  CarePlanType,
  CareReminder,
  ConcernSignal,
  DeviceUsageSummary,
  ElderProfile,
  ElderStatusSnapshot,
  EscalationPolicy,
  FamilyMember,
  FamilyRole,
  NudgeDeliveryState,
  NudgePriority
} from './family-types.js';
import { buildDeviceUsageSummary } from './device-usage-summary.js';

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

const CARE_SECTION_ORDER: Record<CarePlanSection, number> = {
  medicines: 0,
  repeated_reminders: 1,
  one_off_plans: 2,
  important_dates: 3
};

const MEDICINE_KEYWORDS = [/medicine/i, /medication/i, /tablet/i, /pill/i, /dose/i, /dosage/i, /capsule/i];
const IMPORTANT_DATE_KEYWORDS = [/birthday/i, /anniversary/i, /date/i, /celebrat/i, /wedding/i];
const ONE_OFF_KEYWORDS = [/appointment/i, /function/i, /event/i, /visit/i, /meeting/i, /trip/i, /check.?up/i, /party/i];

const normalizeScheduleRank = (value?: string): number => {
  if (!value) return Number.POSITIVE_INFINITY;
  const trimmed = value.trim();
  const timeMatch = trimmed.match(/(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);
    if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.floor(dateMs / 60000);

  return trimmed.toLowerCase().split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
};

const inferSectionFromText = (title: string, description?: string): CarePlanSection => {
  const hay = `${title} ${description ?? ''}`;
  if (MEDICINE_KEYWORDS.some((pattern) => pattern.test(hay))) return 'medicines';
  if (IMPORTANT_DATE_KEYWORDS.some((pattern) => pattern.test(hay))) return 'important_dates';
  if (ONE_OFF_KEYWORDS.some((pattern) => pattern.test(hay))) return 'one_off_plans';
  return 'repeated_reminders';
};

const inferTypeFromSection = (section: CarePlanSection): CarePlanType => {
  if (section === 'medicines') return 'medicine';
  if (section === 'one_off_plans') return 'plan';
  if (section === 'important_dates') return 'date';
  return 'reminder';
};

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

const toUsageSession = (row: typeof elderDeviceUsageSessions.$inferSelect): {
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
} => ({
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  durationSec: row.durationSec
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

const toCarePlanItem = (row: typeof carePlanItems.$inferSelect): CarePlanItem => ({
  id: row.id,
  elderId: row.elderId,
  section: row.section,
  type: row.type,
  title: row.title,
  description: row.description ?? undefined,
  enabled: row.enabled,
  scheduledAt: row.scheduledAt ?? undefined,
  repeatRule: row.repeatRule ?? undefined,
  metadata: row.metadata ?? {},
  sortOrder: row.sortOrder,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  source: 'planner'
});

const toLegacyReminderCareItem = (row: typeof careReminders.$inferSelect): CarePlanItem => {
  const section = inferSectionFromText(row.title, row.description ?? undefined);
  return {
    id: row.id,
    elderId: row.elderId,
    section,
    type: inferTypeFromSection(section),
    title: row.title,
    description: row.description ?? undefined,
    enabled: row.enabled,
    scheduledAt: row.scheduledTime,
    repeatRule: 'daily',
    metadata: {
      origin: 'legacy_reminder'
    },
    sortOrder: normalizeScheduleRank(row.scheduledTime),
    createdAt: row.updatedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    source: 'legacy_reminder'
  };
};

const toLegacyRoutineCareItem = (row: typeof careRoutines.$inferSelect): CarePlanItem => {
  const section = inferSectionFromText(row.title, row.key);
  return {
    id: row.id,
    elderId: row.elderId,
    section: section === 'important_dates' ? 'repeated_reminders' : section,
    type: inferTypeFromSection(section === 'important_dates' ? 'repeated_reminders' : section),
    title: row.title,
    description: row.key,
    enabled: row.enabled,
    scheduledAt: row.schedule,
    repeatRule: 'daily',
    metadata: {
      origin: 'legacy_routine',
      key: row.key
    },
    sortOrder: normalizeScheduleRank(row.schedule),
    createdAt: row.updatedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    source: 'legacy_routine'
  };
};

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

const compareCarePlanItems = (a: CarePlanItem, b: CarePlanItem): number => {
  const sectionDiff = CARE_SECTION_ORDER[a.section] - CARE_SECTION_ORDER[b.section];
  if (sectionDiff !== 0) return sectionDiff;

  const sortDiff = a.sortOrder - b.sortOrder;
  if (sortDiff !== 0) return sortDiff;

  const scheduledDiff = normalizeScheduleRank(a.scheduledAt) - normalizeScheduleRank(b.scheduledAt);
  if (scheduledDiff !== 0) return scheduledDiff;

  return a.title.localeCompare(b.title);
};

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
    const [latestDaily, deviceUsageSummary] = elder
      ? await Promise.all([
          db
            .select()
            .from(insightDailyScores)
            .where(eq(insightDailyScores.elderId, elder.id))
            .orderBy(desc(insightDailyScores.dateKey))
            .limit(1)
            .then((rows) => rows[0] ?? null),
          this.getDeviceUsageSummary(ownerUserId)
        ])
      : [null, this.buildEmptyUsageSummary()];

    return {
      elder,
      device,
      snapshot: {
        elderId: elder?.id ?? 'unknown',
        onlineState: device ? 'online' : 'offline',
        lastInteractionAt: deviceUsageSummary.lastSessionEndedAt ?? undefined,
        latestMoodScore: latestDaily ? latestDaily.emotionalToneScore / 100 : undefined,
        latestEngagementScore: latestDaily ? latestDaily.engagementScore / 100 : undefined,
        deviceUsageSummary,
        updatedAt: Date.now()
      }
    };
  }

  private buildEmptyUsageSummary(now = new Date()): DeviceUsageSummary {
    return {
      totalDurationSec: 0,
      todayDurationSec: 0,
      sessionCount: 0,
      todaySessionCount: 0,
      updatedAt: now.getTime()
    };
  }

  async getDeviceUsageSummary(ownerUserId: string): Promise<DeviceUsageSummary> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) return this.buildEmptyUsageSummary();

    const rows = await db
      .select()
      .from(elderDeviceUsageSessions)
      .where(eq(elderDeviceUsageSessions.elderId, elder.id))
      .orderBy(desc(elderDeviceUsageSessions.endedAt), desc(elderDeviceUsageSessions.startedAt));

    if (rows.length === 0) return this.buildEmptyUsageSummary();
    return buildDeviceUsageSummary(rows.map(toUsageSession), elder.timezone?.trim() || 'Asia/Kolkata');
  }

  async recordDeviceUsageSession(
    ownerUserId: string,
    input: {
      sessionId: string;
      startedAt: number;
      endedAt: number;
      usageSummaryJson?: Record<string, unknown>;
      sessionReason?: string;
    }
  ): Promise<void> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) return;

    const startedAt = new Date(input.startedAt);
    const endedAt = new Date(input.endedAt);
    const durationSec = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
    const usageSummaryJson = {
      ...(input.usageSummaryJson ?? {}),
      sessionReason: input.sessionReason ?? null
    };

    await db
      .insert(elderDeviceUsageSessions)
      .values({
        elderId: elder.id,
        userId: ownerUserId,
        sessionId: input.sessionId,
        startedAt,
        endedAt,
        durationSec,
        usageSummaryJson,
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: elderDeviceUsageSessions.sessionId,
        set: {
          elderId: elder.id,
          userId: ownerUserId,
          startedAt,
          endedAt,
          durationSec,
          usageSummaryJson,
          updatedAt: new Date()
        }
      });
  }

  async addNudge(ownerUserId: string, input: {
    type: 'text' | 'voice';
    text?: string;
    voiceUrl?: string;
    priority: NudgePriority;
    scheduledFor: number;
  }): Promise<NudgeRecord> {
    if (input.type === 'voice') {
      if (!input.voiceUrl || input.voiceUrl.trim().length === 0) {
        throw new Error('voiceUrl is required for voice nudges');
      }
      if (!/^https?:\/\//i.test(input.voiceUrl)) {
        throw new Error('voiceUrl must be an http(s) URL');
      }
    }

    if (input.type === 'text' && (!input.text || input.text.trim().length === 0)) {
      throw new Error('text is required for text nudges');
    }

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
        // Family sends always enter queue first; elder delivery is tracked separately.
        deliveryState: 'queued',
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

  async getPendingNudges(userId: string, limit = 100): Promise<NudgeRecord[]> {
    const elder = await this.getElderByUser(userId);
    if (!elder) return [];

    const rows = await db
      .select()
      .from(nudges)
      .where(
        and(
          eq(nudges.elderId, elder.id),
          inArray(nudges.deliveryState, ['queued', 'delivering', 'delivered']),
          lte(nudges.scheduledAt, new Date())
        )
      )
      .orderBy(
        sql`case
          when ${nudges.priority} = 'urgent' then 0
          when ${nudges.priority} = 'important' then 1
          when ${nudges.priority} = 'gentle' then 2
          else 3
        end`,
        asc(nudges.scheduledAt),
        asc(nudges.createdAt)
      )
      .limit(limit);

    return rows.map(toNudgeRecord);
  }

  async getNextPendingNudge(userId: string): Promise<NudgeRecord | null> {
    const rows = await this.getPendingNudges(userId, 1);
    return rows[0] ?? null;
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

  async markNudgeDelivered(userId: string, nudgeId: string): Promise<NudgeRecord | null> {
    const elder = await this.getElderByUser(userId);
    if (!elder) return null;

    const [updated] = await db
      .update(nudges)
      .set({
        deliveryState: 'delivered',
        updatedAt: new Date()
      })
      .where(
        and(
          eq(nudges.id, nudgeId),
          eq(nudges.elderId, elder.id),
          inArray(nudges.deliveryState, ['queued', 'delivering'])
        )
      )
      .returning();

    return updated ? toNudgeRecord(updated) : null;
  }

  async markNudgesDelivered(userId: string, nudgeIds: string[]): Promise<NudgeRecord[]> {
    const elder = await this.getElderByUser(userId);
    if (!elder) return [];

    const dedupedIds = [...new Set(nudgeIds.map((id) => id.trim()).filter(Boolean))];
    if (dedupedIds.length === 0) return [];

    const updated = await db
      .update(nudges)
      .set({
        deliveryState: 'delivered',
        updatedAt: new Date()
      })
      .where(
        and(
          inArray(nudges.id, dedupedIds),
          eq(nudges.elderId, elder.id),
          inArray(nudges.deliveryState, ['queued', 'delivering'])
        )
      )
      .returning();

    return updated.map(toNudgeRecord);
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

  async getCarePlanItems(ownerUserId: string): Promise<CarePlanItem[]> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) return [];

    const [plannerRows, reminderRows, routineRows] = await Promise.all([
      db.select().from(carePlanItems).where(eq(carePlanItems.elderId, elder.id)),
      db.select().from(careReminders).where(eq(careReminders.elderId, elder.id)),
      db.select().from(careRoutines).where(eq(careRoutines.elderId, elder.id))
    ]);

    const items = [
      ...plannerRows.map(toCarePlanItem),
      ...reminderRows.map(toLegacyReminderCareItem),
      ...routineRows.map(toLegacyRoutineCareItem)
    ];

    return items.sort(compareCarePlanItems);
  }

  async createCarePlanItem(
    ownerUserId: string,
    input: {
      section: CarePlanSection;
      type?: CarePlanType;
      title: string;
      description?: string;
      enabled?: boolean;
      scheduledAt?: string;
      repeatRule?: string;
      metadata?: Record<string, unknown>;
      sortOrder?: number;
    }
  ): Promise<CarePlanItem> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) throw new Error('Elder profile not found');

    const [maxRow] = await db
      .select({ maxSortOrder: sql<number>`coalesce(max(${carePlanItems.sortOrder}), -1)` })
      .from(carePlanItems)
      .where(and(eq(carePlanItems.elderId, elder.id), eq(carePlanItems.section, input.section)));

    const sortOrder = input.sortOrder ?? Number(maxRow?.maxSortOrder ?? -1) + 1;
    const [created] = await db
      .insert(carePlanItems)
      .values({
        elderId: elder.id,
        section: input.section,
        type: input.type ?? inferTypeFromSection(input.section),
        title: input.title,
        description: input.description,
        enabled: input.enabled ?? true,
        scheduledAt: input.scheduledAt,
        repeatRule: input.repeatRule,
        metadata: input.metadata ?? {},
        sortOrder,
        updatedAt: new Date()
      })
      .returning();

    return toCarePlanItem(created);
  }

  async patchCarePlanItem(
    ownerUserId: string,
    itemId: string,
    patch: Partial<{
      section: CarePlanSection;
      type: CarePlanType;
      title: string;
      description?: string;
      enabled: boolean;
      scheduledAt?: string;
      repeatRule?: string;
      metadata?: Record<string, unknown>;
      sortOrder: number;
    }>
  ): Promise<CarePlanItem | null> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) return null;

    const plannerPatch: Partial<typeof carePlanItems.$inferInsert> = {
      updatedAt: new Date()
    };
    if (patch.section !== undefined) plannerPatch.section = patch.section;
    if (patch.type !== undefined) plannerPatch.type = patch.type;
    if (patch.title !== undefined) plannerPatch.title = patch.title;
    if (patch.description !== undefined) plannerPatch.description = patch.description;
    if (patch.enabled !== undefined) plannerPatch.enabled = patch.enabled;
    if (patch.scheduledAt !== undefined) plannerPatch.scheduledAt = patch.scheduledAt;
    if (patch.repeatRule !== undefined) plannerPatch.repeatRule = patch.repeatRule;
    if (patch.metadata !== undefined) plannerPatch.metadata = patch.metadata;
    if (patch.sortOrder !== undefined) plannerPatch.sortOrder = patch.sortOrder;

    const [plannerUpdated] = await db
      .update(carePlanItems)
      .set(plannerPatch)
      .where(and(eq(carePlanItems.id, itemId), eq(carePlanItems.elderId, elder.id)))
      .returning();

    if (plannerUpdated) return toCarePlanItem(plannerUpdated);

    const reminderPatch: Partial<typeof careReminders.$inferInsert> = {
      updatedAt: new Date()
    };
    if (patch.title !== undefined) reminderPatch.title = patch.title;
    if (patch.description !== undefined) reminderPatch.description = patch.description;
    if (patch.scheduledAt !== undefined) reminderPatch.scheduledTime = patch.scheduledAt;
    if (patch.enabled !== undefined) reminderPatch.enabled = patch.enabled;

    const [reminderUpdated] = await db
      .update(careReminders)
      .set(reminderPatch)
      .where(and(eq(careReminders.id, itemId), eq(careReminders.elderId, elder.id)))
      .returning();

    if (reminderUpdated) return toLegacyReminderCareItem(reminderUpdated);

    const routinePatch: Partial<typeof careRoutines.$inferInsert> = {
      updatedAt: new Date()
    };
    if (patch.title !== undefined) routinePatch.title = patch.title;
    if (patch.enabled !== undefined) routinePatch.enabled = patch.enabled;
    if (patch.scheduledAt !== undefined) routinePatch.schedule = patch.scheduledAt;

    const [routineUpdated] = await db
      .update(careRoutines)
      .set(routinePatch)
      .where(and(eq(careRoutines.id, itemId), eq(careRoutines.elderId, elder.id)))
      .returning();

    return routineUpdated ? toLegacyRoutineCareItem(routineUpdated) : null;
  }

  async deleteCarePlanItem(ownerUserId: string, itemId: string): Promise<boolean> {
    const elder = await this.getElderByUser(ownerUserId);
    if (!elder) return false;

    const [plannerDeleted] = await db
      .delete(carePlanItems)
      .where(and(eq(carePlanItems.id, itemId), eq(carePlanItems.elderId, elder.id)))
      .returning({ id: carePlanItems.id });
    if (plannerDeleted) return true;

    const [reminderDeleted] = await db
      .delete(careReminders)
      .where(and(eq(careReminders.id, itemId), eq(careReminders.elderId, elder.id)))
      .returning({ id: careReminders.id });
    if (reminderDeleted) return true;

    const [routineDeleted] = await db
      .delete(careRoutines)
      .where(and(eq(careRoutines.id, itemId), eq(careRoutines.elderId, elder.id)))
      .returning({ id: careRoutines.id });

    return Boolean(routineDeleted);
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
