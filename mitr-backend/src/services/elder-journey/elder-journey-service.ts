import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  carePlanItems,
  careReminders,
  careRoutines,
  elderDeviceUsageSessions,
  elderDevices,
  elderJourneyProfiles,
  elderMedicationEvents,
  elderPromptHistory,
  reminders
} from '../../db/schema.js';
import { getFamilyRepository } from '../family/family-repository.js';
import { ReminderService } from '../reminders/reminder-service.js';
import {
  chooseConversationPlan,
  inferLocalHour,
  resolveEngagementMode,
  resolveRelationshipStage,
  type ConversationPlan,
  type ConversationTriggerType,
  type EngagementMode,
  type JourneySignals,
  type PromptHistorySummaryItem,
  type PromptResponseState,
  type PromptSentiment,
  type RelationshipStage
} from './elder-journey-types.js';

export interface JourneyProfilePatch {
  preferredAddress?: string | null;
  communicationStyle?: 'respectful' | 'direct' | 'warm' | 'chatty';
  proactiveLevel?: 'low' | 'medium' | 'high';
  privacyLevel?: 'minimal' | 'routine_updates' | 'family_visible';
  relationshipStageOverride?: RelationshipStage | null;
  firstSuccessfulInteractionAt?: number | null;
  routineAnchors?: Array<Record<string, unknown>>;
  interests?: Array<Record<string, unknown>>;
  boundaries?: Record<string, unknown>;
  onboardingUseCases?: string[];
}

export interface JourneyProfileSnapshot {
  elderId: string;
  preferredAddress?: string;
  communicationStyle: 'respectful' | 'direct' | 'warm' | 'chatty';
  proactiveLevel: 'low' | 'medium' | 'high';
  privacyLevel: 'minimal' | 'routine_updates' | 'family_visible';
  relationshipStageOverride?: RelationshipStage;
  firstSuccessfulInteractionAt?: number;
  routineAnchors: Array<Record<string, unknown>>;
  interests: Array<Record<string, unknown>>;
  boundaries: Record<string, unknown>;
  onboardingUseCases: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PlannerInput {
  userId: string;
  elderId?: string | null;
  sessionId?: string | null;
  triggerType?: ConversationTriggerType | null;
  reminderId?: string | null;
  reminderTitle?: string | null;
  routineKey?: string | null;
  routineTitle?: string | null;
  recordPrompt?: boolean | null;
  now?: Date;
}

export interface PlannerResult {
  ok: true;
  elderId: string;
  relationshipStage: RelationshipStage;
  engagementMode: EngagementMode;
  signals: JourneySignals;
  journeyProfile: JourneyProfileSnapshot;
  plan: ConversationPlan & { promptHistoryId?: string };
}

export interface PromptOutcomeInput {
  userId: string;
  elderId?: string | null;
  promptHistoryId?: string | null;
  triggerType?: ConversationTriggerType | null;
  promptType?: string | null;
  promptKey?: string | null;
  topic?: string | null;
  responseState: PromptResponseState;
  sentiment?: PromptSentiment | null;
  metadata?: Record<string, unknown>;
}

export interface MedicationResponseInput {
  userId: string;
  elderId?: string | null;
  reminderId?: string | null;
  medicine?: string | null;
  scheduledAt?: string | null;
  status: 'taken' | 'delayed' | 'refused' | 'no_response' | 'unclear';
  responseText?: string | null;
  metadata?: Record<string, unknown>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROFILE: Omit<JourneyProfileSnapshot, 'elderId' | 'createdAt' | 'updatedAt'> = {
  communicationStyle: 'respectful',
  proactiveLevel: 'medium',
  privacyLevel: 'routine_updates',
  routineAnchors: [],
  interests: [],
  boundaries: {},
  onboardingUseCases: []
};

const toMillis = (value: Date | null | undefined): number | undefined => value?.getTime();
const maybeString = (value: string | null | undefined): string | undefined => value?.trim() || undefined;

const toJourneyProfileSnapshot = (
  elderId: string,
  row?: typeof elderJourneyProfiles.$inferSelect | null,
  now = new Date()
): JourneyProfileSnapshot => {
  if (!row) {
    return {
      elderId,
      ...DEFAULT_PROFILE,
      createdAt: now.getTime(),
      updatedAt: now.getTime()
    };
  }

  return {
    elderId,
    preferredAddress: maybeString(row.preferredAddress),
    communicationStyle: row.communicationStyle,
    proactiveLevel: row.proactiveLevel,
    privacyLevel: row.privacyLevel,
    relationshipStageOverride: row.relationshipStageOverride ?? undefined,
    firstSuccessfulInteractionAt: toMillis(row.firstSuccessfulInteractionAt),
    routineAnchors: row.routineAnchors,
    interests: row.interests,
    boundaries: row.boundaries,
    onboardingUseCases: row.onboardingUseCases,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime()
  };
};

const toPromptHistorySummary = (row: typeof elderPromptHistory.$inferSelect): PromptHistorySummaryItem => ({
  promptKey: row.promptKey,
  promptType: row.promptType,
  responseState: row.responseState,
  createdAtMs: row.createdAt.getTime()
});

const parseScheduledAt = (value?: string | null): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export class ElderJourneyService {
  private readonly familyRepo = getFamilyRepository();

  constructor(private readonly reminderService = new ReminderService()) {}

  private async resolveElderForUser(userId: string, elderId?: string | null) {
    const elder = await this.familyRepo.getElderByUser(userId);
    if (!elder) return null;
    if (elderId && elder.id !== elderId) return null;
    return elder;
  }

  private async getJourneyRow(elderId: string): Promise<typeof elderJourneyProfiles.$inferSelect | null> {
    const [row] = await db.select().from(elderJourneyProfiles).where(eq(elderJourneyProfiles.elderId, elderId)).limit(1);
    return row ?? null;
  }

  async getJourneyProfile(userId: string, elderId?: string | null): Promise<JourneyProfileSnapshot | null> {
    const elder = await this.resolveElderForUser(userId, elderId);
    if (!elder) return null;
    return toJourneyProfileSnapshot(elder.id, await this.getJourneyRow(elder.id));
  }

  async upsertJourneyProfile(
    userId: string,
    patch: JourneyProfilePatch,
    elderId?: string | null
  ): Promise<JourneyProfileSnapshot | null> {
    const elder = await this.resolveElderForUser(userId, elderId);
    if (!elder) return null;

    const values: typeof elderJourneyProfiles.$inferInsert = {
      elderId: elder.id,
      preferredAddress: patch.preferredAddress ?? undefined,
      communicationStyle: patch.communicationStyle ?? DEFAULT_PROFILE.communicationStyle,
      proactiveLevel: patch.proactiveLevel ?? DEFAULT_PROFILE.proactiveLevel,
      privacyLevel: patch.privacyLevel ?? DEFAULT_PROFILE.privacyLevel,
      relationshipStageOverride: patch.relationshipStageOverride ?? undefined,
      firstSuccessfulInteractionAt:
        patch.firstSuccessfulInteractionAt === undefined
          ? undefined
          : patch.firstSuccessfulInteractionAt === null
            ? null
            : new Date(patch.firstSuccessfulInteractionAt),
      routineAnchors: patch.routineAnchors ?? DEFAULT_PROFILE.routineAnchors,
      interests: patch.interests ?? DEFAULT_PROFILE.interests,
      boundaries: patch.boundaries ?? DEFAULT_PROFILE.boundaries,
      onboardingUseCases: patch.onboardingUseCases ?? DEFAULT_PROFILE.onboardingUseCases,
      updatedAt: new Date()
    };

    const updateValues: Partial<typeof elderJourneyProfiles.$inferInsert> = {
      updatedAt: new Date()
    };
    if (patch.preferredAddress !== undefined) updateValues.preferredAddress = patch.preferredAddress;
    if (patch.communicationStyle !== undefined) updateValues.communicationStyle = patch.communicationStyle;
    if (patch.proactiveLevel !== undefined) updateValues.proactiveLevel = patch.proactiveLevel;
    if (patch.privacyLevel !== undefined) updateValues.privacyLevel = patch.privacyLevel;
    if (patch.relationshipStageOverride !== undefined) updateValues.relationshipStageOverride = patch.relationshipStageOverride;
    if (patch.firstSuccessfulInteractionAt !== undefined) {
      updateValues.firstSuccessfulInteractionAt =
        patch.firstSuccessfulInteractionAt === null ? null : new Date(patch.firstSuccessfulInteractionAt);
    }
    if (patch.routineAnchors !== undefined) updateValues.routineAnchors = patch.routineAnchors;
    if (patch.interests !== undefined) updateValues.interests = patch.interests;
    if (patch.boundaries !== undefined) updateValues.boundaries = patch.boundaries;
    if (patch.onboardingUseCases !== undefined) updateValues.onboardingUseCases = patch.onboardingUseCases;

    const [row] = await db
      .insert(elderJourneyProfiles)
      .values(values)
      .onConflictDoUpdate({
        target: elderJourneyProfiles.elderId,
        set: updateValues
      })
      .returning();

    return toJourneyProfileSnapshot(elder.id, row);
  }

  private async markFirstSuccessfulInteraction(elderId: string): Promise<void> {
    const existing = await this.getJourneyRow(elderId);
    if (existing?.firstSuccessfulInteractionAt) return;

    if (existing) {
      await db
        .update(elderJourneyProfiles)
        .set({
          firstSuccessfulInteractionAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(elderJourneyProfiles.elderId, elderId));
      return;
    }

    await db.insert(elderJourneyProfiles).values({
      elderId,
      firstSuccessfulInteractionAt: new Date(),
      updatedAt: new Date()
    });
  }

  private async collectSignals(input: {
    userId: string;
    elderId: string;
    elderCreatedAtMs: number;
    deviceLinkedAtMs?: number;
    journeyProfile: JourneyProfileSnapshot;
    now: Date;
  }): Promise<{
    signals: JourneySignals;
    promptHistory: PromptHistorySummaryItem[];
    knownRoutineCount: number;
    knownInterestCount: number;
  }> {
    const sevenDaysAgo = new Date(input.now.getTime() - 7 * DAY_MS);
    const [usageRows, promptRows, careReminderRows, routineRows, careItemRows] = await Promise.all([
      db
        .select()
        .from(elderDeviceUsageSessions)
        .where(eq(elderDeviceUsageSessions.elderId, input.elderId))
        .orderBy(desc(elderDeviceUsageSessions.endedAt)),
      db
        .select()
        .from(elderPromptHistory)
        .where(and(eq(elderPromptHistory.elderId, input.elderId), gte(elderPromptHistory.createdAt, new Date(input.now.getTime() - 30 * DAY_MS))))
        .orderBy(desc(elderPromptHistory.createdAt))
        .limit(80),
      db.select().from(careReminders).where(eq(careReminders.elderId, input.elderId)),
      db.select().from(careRoutines).where(eq(careRoutines.elderId, input.elderId)),
      db.select().from(carePlanItems).where(eq(carePlanItems.elderId, input.elderId))
    ]);

    const elderPromptRows = promptRows;
    const promptRowsLast7d = elderPromptRows.filter((row) => row.createdAt >= sevenDaysAgo);
    const sessionsLast7d = usageRows.filter((row) => row.startedAt >= sevenDaysAgo).length;
    const totalDurationSec = usageRows.reduce((sum, row) => sum + Math.max(0, row.durationSec), 0);
    const knownRoutineCount =
      careReminderRows.length + routineRows.length + careItemRows.filter((row) => row.enabled).length + input.journeyProfile.routineAnchors.length;
    const knownInterestCount = input.journeyProfile.interests.length;

    const signals: JourneySignals = {
      nowMs: input.now.getTime(),
      elderCreatedAtMs: input.elderCreatedAtMs,
      deviceLinkedAtMs: input.deviceLinkedAtMs,
      firstSuccessfulInteractionAtMs: input.journeyProfile.firstSuccessfulInteractionAt,
      sessionCount: usageRows.length,
      sessionsLast7d,
      totalDurationSec,
      knownRoutineCount,
      knownInterestCount,
      promptCountLast7d: promptRowsLast7d.length,
      acceptedPromptCountLast7d: promptRowsLast7d.filter((row) => row.responseState === 'accepted' || row.responseState === 'completed').length,
      refusedPromptCountLast7d: promptRowsLast7d.filter((row) => row.responseState === 'refused').length,
      ignoredPromptCountLast7d: promptRowsLast7d.filter((row) => row.responseState === 'ignored').length,
      stageOverride: input.journeyProfile.relationshipStageOverride
    };

    return {
      signals,
      promptHistory: elderPromptRows.map(toPromptHistorySummary),
      knownRoutineCount,
      knownInterestCount
    };
  }

  async getConversationPlan(input: PlannerInput): Promise<PlannerResult | { ok: false; error: string }> {
    const now = input.now ?? new Date();
    const elder = await this.resolveElderForUser(input.userId, input.elderId);
    if (!elder) return { ok: false, error: 'Elder profile not found for this user' };
    const reminderContext = !input.reminderTitle ? await this.resolveReminderContext(input.userId, input.reminderId) : null;

    const [deviceRow, journeyRow] = await Promise.all([
      db.select().from(elderDevices).where(eq(elderDevices.elderId, elder.id)).limit(1).then((rows) => rows[0] ?? null),
      this.getJourneyRow(elder.id)
    ]);
    const journeyProfile = toJourneyProfileSnapshot(elder.id, journeyRow, now);
    const { signals, promptHistory, knownRoutineCount, knownInterestCount } = await this.collectSignals({
      userId: input.userId,
      elderId: elder.id,
      elderCreatedAtMs: elder.createdAt,
      deviceLinkedAtMs: deviceRow?.linkedAt.getTime(),
      journeyProfile,
      now
    });

    signals.ageRange = elder.ageRange;
    const relationshipStage = resolveRelationshipStage(signals);
    const engagementMode = resolveEngagementMode(signals);
    const localHour = inferLocalHour(now, elder.timezone || 'Asia/Kolkata');

    const plan = chooseConversationPlan({
      nowMs: now.getTime(),
      triggerType: input.triggerType ?? 'session_start',
      relationshipStage,
      engagementMode,
      localHour,
      promptHistory,
      elderName: elder.name,
      ageRange: elder.ageRange,
      preferredAddress: journeyProfile.preferredAddress,
      reminderTitle: input.reminderTitle ?? reminderContext?.title,
      routineTitle: input.routineTitle,
      routineKey: input.routineKey,
      knownRoutineCount,
      knownInterestCount,
      routineAnchors: journeyProfile.routineAnchors,
      interests: journeyProfile.interests,
      onboardingUseCases: journeyProfile.onboardingUseCases,
      boundaries: journeyProfile.boundaries
    });

    let promptHistoryId: string | undefined;
    if (input.recordPrompt ?? true) {
      const [created] = await db
        .insert(elderPromptHistory)
        .values({
          elderId: elder.id,
          userId: input.userId,
          sessionId: input.sessionId ?? undefined,
          triggerType: input.triggerType ?? 'session_start',
          promptType: plan.promptType,
          promptKey: plan.promptKey,
          topic: plan.topic,
          responseState: 'planned',
          metadata: {
            intent: plan.intent,
            relationshipStage,
            engagementMode,
            reminderId: input.reminderId ?? null,
            routineKey: input.routineKey ?? null
          },
          updatedAt: now
        })
        .returning({ id: elderPromptHistory.id });
      promptHistoryId = created.id;
    }

    return {
      ok: true,
      elderId: elder.id,
      relationshipStage,
      engagementMode,
      signals,
      journeyProfile,
      plan: {
        ...plan,
        promptHistoryId
      }
    };
  }

  async recordPromptOutcome(input: PromptOutcomeInput): Promise<{ ok: boolean; promptHistoryId?: string; error?: string }> {
    const elder = await this.resolveElderForUser(input.userId, input.elderId);
    if (!elder) return { ok: false, error: 'Elder profile not found for this user' };

    if (input.promptHistoryId) {
      const setValues: Partial<typeof elderPromptHistory.$inferInsert> = {
        responseState: input.responseState,
        sentiment: input.sentiment ?? undefined,
        updatedAt: new Date()
      };
      if (input.metadata !== undefined) setValues.metadata = input.metadata;

      const [updated] = await db
        .update(elderPromptHistory)
        .set(setValues)
        .where(and(eq(elderPromptHistory.id, input.promptHistoryId), eq(elderPromptHistory.elderId, elder.id)))
        .returning({ id: elderPromptHistory.id });

      if (updated && (input.responseState === 'accepted' || input.responseState === 'completed')) {
        await this.markFirstSuccessfulInteraction(elder.id);
      }
      return updated ? { ok: true, promptHistoryId: updated.id } : { ok: false, error: 'Prompt history item not found' };
    }

    if (!input.promptType || !input.promptKey) {
      return { ok: false, error: 'promptType and promptKey are required when promptHistoryId is missing' };
    }

    const [created] = await db
      .insert(elderPromptHistory)
      .values({
        elderId: elder.id,
        userId: input.userId,
        triggerType: input.triggerType ?? 'manual',
        promptType: input.promptType,
        promptKey: input.promptKey,
        topic: input.topic ?? undefined,
        responseState: input.responseState,
        sentiment: input.sentiment ?? undefined,
        metadata: input.metadata ?? {},
        updatedAt: new Date()
      })
      .returning({ id: elderPromptHistory.id });

    if (input.responseState === 'accepted' || input.responseState === 'completed') {
      await this.markFirstSuccessfulInteraction(elder.id);
    }
    return { ok: true, promptHistoryId: created.id };
  }

  async recordMedicationResponse(input: MedicationResponseInput): Promise<{ ok: boolean; eventId?: string; error?: string }> {
    const elder = await this.resolveElderForUser(input.userId, input.elderId);
    if (!elder) return { ok: false, error: 'Elder profile not found for this user' };

    const scheduledAt = parseScheduledAt(input.scheduledAt);
    const [created] = await db
      .insert(elderMedicationEvents)
      .values({
        elderId: elder.id,
        userId: input.userId,
        reminderId: input.reminderId ?? undefined,
        medicine: input.medicine ?? undefined,
        scheduledAt: scheduledAt ?? undefined,
        status: input.status,
        responseText: input.responseText ?? undefined,
        metadata: input.metadata ?? {}
      })
      .returning({ id: elderMedicationEvents.id });

    if (input.status === 'taken') {
      if (input.reminderId) {
        await this.reminderService.acknowledge(input.userId, input.reminderId);
      }
      await this.markFirstSuccessfulInteraction(elder.id);
    }

    return { ok: true, eventId: created.id };
  }

  async resolveReminderContext(
    userId: string,
    reminderId?: string | null
  ): Promise<{ reminderId?: string; title?: string; datetimeISO?: string } | null> {
    if (!reminderId) return null;
    const [row] = await db
      .select({ id: reminders.id, title: reminders.title, datetimeISO: reminders.datetimeIso })
      .from(reminders)
      .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)))
      .limit(1);
    return row ?? null;
  }
}
