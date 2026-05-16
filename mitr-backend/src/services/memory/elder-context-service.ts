import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { getSharedRedisClient } from '../../lib/redis.js';
import {
  elderContextCardEvents,
  elderContextCards,
  elderJourneyProfiles,
  elderMemoryItems,
  elderPromptHistory
} from '../../db/schema.js';
import { getFamilyRepository } from '../family/family-repository.js';
import type { ElderProfile } from '../family/family-types.js';
import type { Mem0SearchResult } from './mem0-service.js';
import {
  buildContextPacket,
  type ContextCardEventType,
  type ContextCardType,
  type ContextPacket,
  type MemoryType,
  type MentionPolicy
} from './elder-context-types.js';

type ContextCardInsert = typeof elderContextCards.$inferInsert;
type ContextCardRow = typeof elderContextCards.$inferSelect;
type MemoryItemInsert = typeof elderMemoryItems.$inferInsert;
type MemoryRow = typeof elderMemoryItems.$inferSelect;

export interface ContextPacketInput {
  userId: string;
  elderId?: string | null;
  sessionId?: string | null;
  triggerType?: string | null;
  includeDebug?: boolean | null;
  cacheOnly?: boolean | null;
  allowStale?: boolean | null;
  now?: Date;
}

export interface MemoryItemInput {
  userId: string;
  elderId?: string | null;
  memoryType: MemoryType;
  subject: string;
  summary?: string | null;
  valueJson?: Record<string, unknown>;
  importance?: number;
  confidence?: number;
  sourceType?: MemoryItemInsert['sourceType'];
  sourceId?: string | null;
  visibility?: 'private' | 'caregiver_visible' | 'internal_only';
  expiresAt?: Date | null;
  mem0UserId?: string | null;
  mem0EventId?: string | null;
  mem0MemoryId?: string | null;
  mem0Status?: MemoryItemInsert['mem0Status'];
  mem0IndexedAt?: Date | null;
  contentHash?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ContextCardInput {
  userId: string;
  elderId?: string | null;
  cardType: ContextCardType;
  sourceType?: ContextCardInsert['sourceType'];
  sourceId?: string | null;
  dedupeKey?: string | null;
  title: string;
  summary: string;
  priority?: number;
  mentionPolicy?: MentionPolicy;
  dueAt?: Date;
  expiresAt?: Date | null;
  cooldownUntil?: Date | null;
  maxMentions?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextOutcomeInput {
  userId: string;
  elderId?: string | null;
  sessionId?: string | null;
  cardId?: string | null;
  dedupeKey?: string | null;
  eventType: ContextCardEventType;
  responseState?: 'accepted' | 'refused' | 'ignored' | 'unclear' | 'completed' | null;
  notes?: string | null;
  cooldownMinutes?: number | null;
  metadata?: Record<string, unknown>;
}

export interface AuthorizedMem0Memory {
  registryId: string;
  mem0MemoryId: string;
  memoryType: MemoryType;
  subject: string;
  summary: string;
  importance: number;
  confidence: number;
  visibility: MemoryRow['visibility'];
  score?: number;
  categories: string[];
  metadata: Record<string, unknown>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CONTEXT_PACKET_CACHE_TTL_SEC = 20;
const CONTEXT_PACKET_STALE_TTL_SEC = 5 * 60;
const ELDER_RESOLUTION_CACHE_TTL_MS = 60 * 1000;
const MEDICINE_RE = /\b(medicine|medication|tablet|pill|dose|capsule|dawai|dawa|दवा|दवाई)\b/i;

const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value as number)));
};

const toMillis = (value: Date | null | undefined): number | undefined => value?.getTime();

const toCardCandidate = (row: ContextCardRow) => ({
  id: row.id,
  cardType: row.cardType,
  title: row.title,
  summary: row.summary,
  priority: row.priority,
  status: row.status,
  mentionPolicy: row.mentionPolicy,
  dueAtMs: row.dueAt.getTime(),
  expiresAtMs: toMillis(row.expiresAt),
  cooldownUntilMs: toMillis(row.cooldownUntil),
  lastMentionedAtMs: toMillis(row.lastMentionedAt),
  mentionCount: row.mentionCount,
  maxMentions: row.maxMentions,
  metadata: row.metadata
});

const toMemoryCandidate = (row: MemoryRow) => ({
  id: row.id,
  memoryType: row.memoryType,
  subject: row.subject,
  summary: row.summary ?? '',
  importance: row.importance,
  confidence: row.confidence,
  metadata: row.metadata
});

const readMetadataString = (metadata: Record<string, unknown>, key: string): string | null => {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const reminderCardType = (title: string): ContextCardType => (MEDICINE_RE.test(title) ? 'medication_followup' : 'reminder_followup');

const reminderPriority = (cardType: ContextCardType): number => (cardType === 'medication_followup' ? 88 : 68);
const reminderExpiry = (cardType: ContextCardType, firedAt: Date): Date =>
  new Date(firedAt.getTime() + (cardType === 'medication_followup' ? 6 : 24) * 60 * 60 * 1000);

export class ElderContextService {
  private readonly familyRepo = getFamilyRepository();
  private readonly redis = getSharedRedisClient();
  private static readonly packetCache = new Map<string, { packet: ContextPacket; expiresAt: number; staleUntil: number }>();
  private static readonly elderCache = new Map<string, { elder: ElderProfile; expiresAt: number }>();

  private async resolveElderForUser(userId: string, elderId?: string | null) {
    const cacheKey = `${userId}:${elderId ?? ''}`;
    const cached = ElderContextService.elderCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.elder;

    const elder = await this.familyRepo.getElderByUser(userId);
    if (!elder) return null;
    if (elderId && elder.id !== elderId) return null;
    ElderContextService.elderCache.set(cacheKey, {
      elder,
      expiresAt: Date.now() + ELDER_RESOLUTION_CACHE_TTL_MS
    });
    return elder;
  }

  async getContextPacket(input: ContextPacketInput): Promise<ContextPacket | { ok: false; error: string }> {
    const now = input.now ?? new Date();
    if (input.cacheOnly) {
      const elderId = input.elderId?.trim();
      if (!elderId) return { ok: false, error: 'Context packet cache-only request requires elderId' };

      const cached = await this.getCachedContextPacket(elderId, false);
      if (!cached) return { ok: false, error: 'Context packet fresh cache miss' };
      return this.withPacketFreshness(cached, 'fresh_cache', now);
    }

    const elder = await this.resolveElderForUser(input.userId, input.elderId);
    if (!elder) return { ok: false, error: 'Elder profile not found for this user' };

    if (!input.includeDebug) {
      const cached = await this.getCachedContextPacket(elder.id, false);
      if (cached) return this.withPacketFreshness(cached, 'fresh_cache', now);
    }

    const stale = !input.includeDebug && input.allowStale ? await this.getCachedContextPacket(elder.id, true) : null;
    const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);
    try {
      const [cards, memories, promptRows, journeyRows] = await Promise.all([
        db
          .select()
          .from(elderContextCards)
          .where(
            and(
              eq(elderContextCards.elderId, elder.id),
              inArray(elderContextCards.status, ['pending', 'snoozed']),
              or(isNull(elderContextCards.expiresAt), gt(elderContextCards.expiresAt, now)),
              or(isNull(elderContextCards.cooldownUntil), lte(elderContextCards.cooldownUntil, now))
            )
          )
          .orderBy(desc(elderContextCards.priority), elderContextCards.dueAt)
          .limit(80),
        db
          .select()
          .from(elderMemoryItems)
          .where(
            and(
              eq(elderMemoryItems.elderId, elder.id),
              eq(elderMemoryItems.status, 'active'),
              or(isNull(elderMemoryItems.expiresAt), gt(elderMemoryItems.expiresAt, now))
            )
          )
          .orderBy(desc(elderMemoryItems.importance), desc(elderMemoryItems.confidence), desc(elderMemoryItems.updatedAt))
          .limit(24),
        db
          .select()
          .from(elderPromptHistory)
          .where(and(eq(elderPromptHistory.elderId, elder.id), gt(elderPromptHistory.createdAt, thirtyDaysAgo)))
          .orderBy(desc(elderPromptHistory.createdAt))
          .limit(12),
        db.select().from(elderJourneyProfiles).where(eq(elderJourneyProfiles.elderId, elder.id)).limit(1)
      ]);

      const journey = journeyRows[0] ?? null;
      const boundaries = journey?.boundaries ?? {};
      const avoidTopics = Array.isArray(boundaries.avoidTopics)
        ? boundaries.avoidTopics.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];

      const packet = buildContextPacket({
        elderId: elder.id,
        now,
        triggerType: input.triggerType,
        cards: cards.map(toCardCandidate),
        memories: memories.map(toMemoryCandidate),
        avoidPromptKeys: promptRows.map((row) => row.promptKey),
        avoidTopics,
        proactiveLevel: journey?.proactiveLevel ?? 'medium',
        includeDebug: input.includeDebug ?? false
      });

      if (!input.includeDebug) {
        await this.cacheContextPacket(elder.id, packet);
      }
      return this.withPacketFreshness(packet, 'live', now);
    } catch (error) {
      if (stale) {
        return this.withPacketFreshness(stale, 'stale_cache', now, (error as Error).message);
      }
      return { ok: false, error: 'Context packet database unavailable' };
    }
  }

  private contextPacketCacheKey(elderId: string): string {
    return `elder:${elderId}:context_packet:v1`;
  }

  private async getCachedContextPacket(elderId: string, allowStale: boolean): Promise<ContextPacket | null> {
    const key = this.contextPacketCacheKey(elderId);
    const now = Date.now();
    const memoryCached = ElderContextService.packetCache.get(key);
    if (memoryCached && (allowStale ? memoryCached.staleUntil > now : memoryCached.expiresAt > now)) {
      return memoryCached.packet;
    }

    if (!this.redis) return null;

    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { packet?: ContextPacket; expiresAt?: number; staleUntil?: number };
      if (!parsed.packet || !parsed.expiresAt || !parsed.staleUntil) return null;
      ElderContextService.packetCache.set(key, parsed as { packet: ContextPacket; expiresAt: number; staleUntil: number });
      if (allowStale ? parsed.staleUntil > now : parsed.expiresAt > now) return parsed.packet;
    } catch {
      return null;
    }
    return null;
  }

  private async cacheContextPacket(elderId: string, packet: ContextPacket): Promise<void> {
    const key = this.contextPacketCacheKey(elderId);
    const cached = {
      packet: this.stripPacketFreshness(packet),
      expiresAt: Date.now() + CONTEXT_PACKET_CACHE_TTL_SEC * 1000,
      staleUntil: Date.now() + CONTEXT_PACKET_STALE_TTL_SEC * 1000
    };
    ElderContextService.packetCache.set(key, cached);
    if (!this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(cached), 'EX', CONTEXT_PACKET_STALE_TTL_SEC);
    } catch {
      // Cache writes must never affect voice latency.
    }
  }

  private async invalidateContextCache(elderId: string): Promise<void> {
    const key = this.contextPacketCacheKey(elderId);
    ElderContextService.packetCache.delete(key);
    if (!this.redis) return;
    try {
      await this.redis.del(key);
    } catch {
      // Cache invalidation is best-effort; stale entries expire quickly.
    }
  }

  private stripPacketFreshness(packet: ContextPacket): ContextPacket {
    const { freshness: _freshness, ...withoutFreshness } = packet;
    return withoutFreshness;
  }

  private withPacketFreshness(
    packet: ContextPacket,
    source: NonNullable<ContextPacket['freshness']>['source'],
    now: Date,
    degradedReason?: string
  ): ContextPacket {
    const generatedAtMs = Date.parse(packet.generatedAt);
    const ageMs = Number.isFinite(generatedAtMs) ? Math.max(0, now.getTime() - generatedAtMs) : 0;
    return {
      ...this.stripPacketFreshness(packet),
      freshness: {
        source,
        ageMs,
        stale: source === 'stale_cache',
        ...(degradedReason ? { degradedReason } : {})
      }
    };
  }

  async addMemoryItem(input: MemoryItemInput): Promise<{ ok: true; memoryId: string; existing?: boolean } | { ok: false; error: string }> {
    const elder = await this.resolveElderForUser(input.userId, input.elderId);
    if (!elder) return { ok: false, error: 'Elder profile not found for this user' };

    if (input.contentHash) {
      const [existing] = await db
        .select({ id: elderMemoryItems.id, mem0Status: elderMemoryItems.mem0Status })
        .from(elderMemoryItems)
        .where(
          and(
            eq(elderMemoryItems.elderId, elder.id),
            eq(elderMemoryItems.status, 'active'),
            eq(elderMemoryItems.contentHash, input.contentHash)
          )
        )
        .limit(1);
      if (existing && existing.mem0Status !== 'failed') return { ok: true, memoryId: existing.id, existing: true };
    }

    const summary = input.summary?.trim();
    const [created] = await db
      .insert(elderMemoryItems)
      .values({
        elderId: elder.id,
        userId: input.userId,
        memoryType: input.memoryType,
        subject: input.subject.trim(),
        summary: summary && summary.length > 0 ? summary : undefined,
        valueJson: input.valueJson ?? {},
        importance: clampInt(input.importance, 50, 0, 100),
        confidence: clampInt(input.confidence, 70, 0, 100),
        sourceType:
          input.sourceType === 'assistant_inference'
            ? 'assistant_inference'
            : input.sourceType ?? 'system',
        sourceId: input.sourceId ?? undefined,
        visibility: input.visibility ?? 'private',
        expiresAt: input.expiresAt ?? undefined,
        mem0UserId: input.mem0UserId ?? undefined,
        mem0EventId: input.mem0EventId ?? undefined,
        mem0MemoryId: input.mem0MemoryId ?? undefined,
        mem0Status: input.mem0Status ?? 'not_indexed',
        mem0IndexedAt: input.mem0IndexedAt ?? undefined,
        contentHash: input.contentHash ?? undefined,
        metadata: input.metadata ?? {},
        updatedAt: new Date()
      })
      .returning({ id: elderMemoryItems.id });

    await this.invalidateContextCache(elder.id);
    return { ok: true, memoryId: created.id };
  }

  async updateMemoryMem0State(input: {
    userId: string;
    elderId?: string | null;
    memoryId: string;
    mem0EventId?: string | null;
    mem0MemoryId?: string | null;
    mem0Status: MemoryItemInsert['mem0Status'];
    error?: string | null;
  }): Promise<{ ok: boolean; memoryId?: string; error?: string }> {
    const elder = await this.resolveElderForUser(input.userId, input.elderId);
    if (!elder) return { ok: false, error: 'Elder profile not found for this user' };

    const metadataPatch = input.error ? { mem0Error: input.error } : {};
    const [updated] = await db
      .update(elderMemoryItems)
      .set({
        mem0EventId: input.mem0EventId ?? undefined,
        mem0MemoryId: input.mem0MemoryId ?? undefined,
        mem0Status: input.mem0Status,
        mem0IndexedAt: input.mem0Status === 'indexed' ? new Date() : undefined,
        metadata: sql`${elderMemoryItems.metadata} || ${JSON.stringify(metadataPatch)}::jsonb` as unknown as Record<string, unknown>,
        updatedAt: new Date()
      })
      .where(and(eq(elderMemoryItems.id, input.memoryId), eq(elderMemoryItems.elderId, elder.id)))
      .returning({ id: elderMemoryItems.id });

    await this.invalidateContextCache(elder.id);
    return updated ? { ok: true, memoryId: updated.id } : { ok: false, error: 'Memory registry row not found' };
  }

  async authorizeMem0SearchResults(input: {
    userId: string;
    elderId?: string | null;
    results: Mem0SearchResult[];
    audience?: 'agent' | 'caregiver';
    now?: Date;
  }): Promise<AuthorizedMem0Memory[]> {
    const elder = await this.resolveElderForUser(input.userId, input.elderId);
    if (!elder) return [];

    const registryIds = input.results
      .map((result) => readMetadataString(result.metadata, 'registryId') ?? readMetadataString(result.metadata, 'mitrRegistryId'))
      .filter((id): id is string => Boolean(id));
    if (registryIds.length === 0) return [];

    const now = input.now ?? new Date();
    const rows = await db
      .select()
      .from(elderMemoryItems)
      .where(
        and(
          eq(elderMemoryItems.elderId, elder.id),
          eq(elderMemoryItems.status, 'active'),
          inArray(elderMemoryItems.id, [...new Set(registryIds)]),
          or(isNull(elderMemoryItems.expiresAt), gt(elderMemoryItems.expiresAt, now))
        )
      );

    const allowedVisibilities: Array<MemoryRow['visibility']> =
      input.audience === 'caregiver' ? ['caregiver_visible'] : ['private', 'caregiver_visible'];
    const rowById = new Map(
      rows
        .filter((row) => allowedVisibilities.includes(row.visibility))
        .map((row) => [row.id, row])
    );

    const authorized = input.results.flatMap((result) => {
      const registryId =
        readMetadataString(result.metadata, 'registryId') ?? readMetadataString(result.metadata, 'mitrRegistryId');
      if (!registryId) return [];
      const row = rowById.get(registryId);
      if (!row) return [];
      return [
        {
          registryId: row.id,
          mem0MemoryId: result.id,
          memoryType: row.memoryType,
          subject: row.subject,
          summary: result.memory,
          importance: row.importance,
          confidence: row.confidence,
          visibility: row.visibility,
          score: result.score,
          categories: result.categories,
          metadata: {
            ...(row.metadata ?? {}),
            mem0: result.metadata
          }
        }
      ];
    });

    for (const memory of authorized) {
      await db
        .update(elderMemoryItems)
        .set({
          mem0MemoryId: memory.mem0MemoryId,
          mem0Status: 'indexed',
          mem0IndexedAt: now,
          lastAccessedAt: now,
          accessCount: sql`${elderMemoryItems.accessCount} + 1` as unknown as number,
          updatedAt: now
        })
        .where(and(eq(elderMemoryItems.id, memory.registryId), eq(elderMemoryItems.elderId, elder.id)));
    }

    return authorized;
  }

  async upsertContextCard(input: ContextCardInput): Promise<{ ok: true; cardId: string } | { ok: false; error: string }> {
    const elder = await this.resolveElderForUser(input.userId, input.elderId);
    if (!elder) return { ok: false, error: 'Elder profile not found for this user' };

    const values: ContextCardInsert = {
      elderId: elder.id,
      userId: input.userId,
      cardType: input.cardType,
      sourceType: input.sourceType ?? 'system',
      sourceId: input.sourceId ?? undefined,
      dedupeKey: input.dedupeKey ?? undefined,
      title: input.title.trim(),
      summary: input.summary.trim(),
      priority: clampInt(input.priority, 50, 0, 100),
      status: 'pending',
      mentionPolicy: input.mentionPolicy ?? 'when_conversational',
      dueAt: input.dueAt ?? new Date(),
      expiresAt: input.expiresAt ?? undefined,
      cooldownUntil: input.cooldownUntil ?? undefined,
      mentionCount: 0,
      maxMentions: clampInt(input.maxMentions, 1, 1, 10),
      metadata: input.metadata ?? {},
      updatedAt: new Date()
    };

    const insert = db.insert(elderContextCards).values(values);
    const [row] = input.dedupeKey
      ? await insert
          .onConflictDoUpdate({
            target: [elderContextCards.elderId, elderContextCards.dedupeKey],
            set: {
              title: values.title,
              summary: values.summary,
              priority: values.priority,
              status: 'pending',
              mentionPolicy: values.mentionPolicy,
              dueAt: values.dueAt,
              expiresAt: values.expiresAt,
              cooldownUntil: values.cooldownUntil,
              maxMentions: values.maxMentions,
              metadata: values.metadata,
              updatedAt: new Date()
            }
          })
          .returning({ id: elderContextCards.id })
      : await insert.returning({ id: elderContextCards.id });

    await this.recordCardEvent({
      cardId: row.id,
      elderId: elder.id,
      userId: input.userId,
      eventType: 'created',
      metadata: { dedupeKey: input.dedupeKey ?? null }
    });

    await this.invalidateContextCache(elder.id);
    return { ok: true, cardId: row.id };
  }

  async createReminderFiredCard(input: {
    userId: string;
    elderId?: string | null;
    reminderId: string;
    title: string;
    firedAt?: Date;
    language?: string | null;
  }): Promise<{ ok: true; cardId: string } | { ok: false; error: string }> {
    const firedAt = input.firedAt ?? new Date();
    const cardType = reminderCardType(input.title);
    const dedupeKey = `reminder:${input.reminderId}:${cardType}`;

    return this.upsertContextCard({
      userId: input.userId,
      elderId: input.elderId,
      cardType,
      sourceType: 'reminder',
      sourceId: input.reminderId,
      dedupeKey,
      title: input.title,
      summary:
        cardType === 'medication_followup'
          ? `${input.title} reminder fired and still needs medication confirmation.`
          : `${input.title} reminder fired and may need a gentle follow-up.`,
      priority: reminderPriority(cardType),
      mentionPolicy: cardType === 'medication_followup' ? 'first_safe_user_turn' : 'when_conversational',
      dueAt: firedAt,
      expiresAt: reminderExpiry(cardType, firedAt),
      maxMentions: cardType === 'medication_followup' ? 2 : 1,
      metadata: {
        reminderId: input.reminderId,
        language: input.language ?? null,
        firedAt: firedAt.toISOString()
      }
    });
  }

  async recordMedicationContext(input: {
    userId: string;
    elderId?: string | null;
    reminderId?: string | null;
    medicine?: string | null;
    status: 'taken' | 'delayed' | 'refused' | 'no_response' | 'unclear';
    responseText?: string | null;
  }): Promise<void> {
    const reminderId = input.reminderId?.trim();
    if (!reminderId) return;
    const title = input.medicine?.trim() || 'medicine';
    const dedupeKey = `reminder:${reminderId}:medication_followup`;

    if (input.status === 'taken') {
      await this.recordCardOutcome({
        userId: input.userId,
        elderId: input.elderId,
        dedupeKey,
        eventType: 'completed',
        responseState: 'completed',
        notes: input.responseText ?? undefined,
        metadata: { medicationStatus: input.status }
      });
      return;
    }

    if (input.status === 'refused') {
      await this.recordCardOutcome({
        userId: input.userId,
        elderId: input.elderId,
        dedupeKey,
        eventType: 'dismissed',
        responseState: 'refused',
        notes: input.responseText ?? undefined,
        metadata: { medicationStatus: input.status }
      });
      return;
    }

    if (input.status === 'delayed') {
      await this.upsertContextCard({
        userId: input.userId,
        elderId: input.elderId,
        cardType: 'medication_followup',
        sourceType: 'medication_event',
        sourceId: reminderId,
        dedupeKey,
        title,
        summary: `${title} was delayed by the elder and needs a later confirmation.`,
        priority: 86,
        mentionPolicy: 'first_safe_user_turn',
        dueAt: new Date(Date.now() + 10 * 60 * 1000),
        expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
        maxMentions: 2,
        metadata: { medicationStatus: input.status, reminderId }
      });
      return;
    }

    await this.upsertContextCard({
      userId: input.userId,
      elderId: input.elderId,
      cardType: 'medication_followup',
      sourceType: 'medication_event',
      sourceId: reminderId,
      dedupeKey,
      title,
      summary: `${title} was not confirmed after a medication reminder.`,
      priority: input.status === 'no_response' ? 94 : 88,
      mentionPolicy: 'first_safe_user_turn',
      dueAt: new Date(),
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      maxMentions: 2,
      metadata: { medicationStatus: input.status, reminderId, responseText: input.responseText ?? null }
    });
  }

  async recordCardOutcome(input: ContextOutcomeInput): Promise<{ ok: boolean; cardId?: string; error?: string }> {
    const elder = await this.resolveElderForUser(input.userId, input.elderId);
    if (!elder) return { ok: false, error: 'Elder profile not found for this user' };

    const [card] = input.cardId
      ? await db
          .select()
          .from(elderContextCards)
          .where(and(eq(elderContextCards.id, input.cardId), eq(elderContextCards.elderId, elder.id)))
          .limit(1)
      : input.dedupeKey
        ? await db
            .select()
            .from(elderContextCards)
            .where(and(eq(elderContextCards.elderId, elder.id), eq(elderContextCards.dedupeKey, input.dedupeKey)))
            .limit(1)
        : [];

    if (!card) return { ok: false, error: 'Context card not found' };

    const now = new Date();
    const nextStatus = this.statusForOutcome(input.eventType, input.responseState, card.status);
    const setValues: Partial<ContextCardInsert> = {
      status: nextStatus,
      updatedAt: now
    };

    if (input.eventType === 'mentioned') {
      setValues.lastMentionedAt = now;
      setValues.mentionCount = sql`${elderContextCards.mentionCount} + 1` as unknown as number;
      if (input.cooldownMinutes) {
        setValues.cooldownUntil = new Date(now.getTime() + input.cooldownMinutes * 60 * 1000);
      }
    } else if (input.eventType === 'snoozed') {
      setValues.cooldownUntil = new Date(now.getTime() + (input.cooldownMinutes ?? 10) * 60 * 1000);
    }

    const [updated] = await db
      .update(elderContextCards)
      .set(setValues)
      .where(and(eq(elderContextCards.id, card.id), eq(elderContextCards.elderId, elder.id)))
      .returning({ id: elderContextCards.id });

    await this.recordCardEvent({
      cardId: card.id,
      elderId: elder.id,
      userId: input.userId,
      sessionId: input.sessionId ?? undefined,
      eventType: input.eventType,
      responseState: input.responseState ?? undefined,
      notes: input.notes ?? undefined,
      metadata: input.metadata ?? {}
    });

    await this.invalidateContextCache(elder.id);
    return updated ? { ok: true, cardId: updated.id } : { ok: false, error: 'Context card update failed' };
  }

  private statusForOutcome(
    eventType: ContextCardEventType,
    responseState: ContextOutcomeInput['responseState'],
    current: ContextCardRow['status']
  ): ContextCardRow['status'] {
    if (eventType === 'completed' || responseState === 'accepted' || responseState === 'completed') return 'completed';
    if (eventType === 'dismissed' || responseState === 'refused') return 'dismissed';
    if (eventType === 'expired') return 'expired';
    if (eventType === 'snoozed') return 'snoozed';
    return current === 'snoozed' ? 'pending' : current;
  }

  private async recordCardEvent(input: {
    cardId: string;
    elderId: string;
    userId: string;
    sessionId?: string;
    eventType: ContextCardEventType;
    responseState?: 'accepted' | 'refused' | 'ignored' | 'unclear' | 'completed';
    notes?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await db.insert(elderContextCardEvents).values({
      cardId: input.cardId,
      elderId: input.elderId,
      userId: input.userId,
      sessionId: input.sessionId,
      eventType: input.eventType,
      responseState: input.responseState,
      notes: input.notes,
      metadata: input.metadata ?? {}
    });
  }
}
