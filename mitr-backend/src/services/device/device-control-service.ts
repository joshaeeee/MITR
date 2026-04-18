import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { AccessToken, AgentDispatchClient, VideoGrant } from 'livekit-server-sdk';
import { db } from '../../db/client.js';
import {
  deviceClaims,
  devicePairings,
  devices,
  deviceSessions,
  deviceTelemetry,
  elderProfiles,
  firmwareReleases
} from '../../db/schema.js';
import { getRequiredLivekitConfig } from '../../config/livekit-config.js';
import { getFamilyRepository } from '../family/family-repository.js';
import { publishDeviceSessionEvent } from './device-session-events.js';

type DevicePairingStatus = 'pending_device' | 'bootstrapping' | 'completed' | 'expired' | 'revoked';
export type DeviceConversationState = 'idle' | 'starting' | 'active' | 'ending';

export interface DeviceAuthRecord {
  id: string;
  deviceId: string;
  userId: string;
  familyId: string | null;
  elderId: string | null;
  claimedByUserId: string | null;
  displayName: string | null;
  hardwareRev: string | null;
  firmwareVersion: string | null;
  metadataJson: Record<string, unknown>;
}

export interface DeviceSessionRecord {
  id: string;
  deviceId: string;
  userId: string;
  familyId: string | null;
  elderId: string | null;
  claimedByUserId: string | null;
  roomName: string;
  participantIdentity: string;
  language: string;
  firmwareVersion: string | null;
  hardwareRev: string | null;
  status: 'issued' | 'active' | 'ended';
  conversationState: DeviceConversationState;
  metadata: Record<string, unknown>;
  startedAt: number;
  lastHeartbeatAt: number;
  lastWakeDetectedAt: number | null;
  conversationStartedAt: number | null;
  conversationEndedAt: number | null;
  lastWakewordModel: string | null;
  lastWakewordScore: string | null;
  lastConversationEndReason: string | null;
  endedAt: number | null;
  endReason: string | null;
}

export interface ClaimedDeviceSummary {
  deviceId: string;
  userId: string;
  familyId: string | null;
  elderId: string | null;
  claimedByUserId: string | null;
  displayName: string | null;
  hardwareRev: string | null;
  firmwareVersion: string | null;
  claimedAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  metadata: Record<string, unknown>;
  lastSession: {
    id: string;
    roomName: string;
    participantIdentity: string;
    status: 'issued' | 'active' | 'ended';
    conversationState: DeviceConversationState;
    startedAt: number;
    lastHeartbeatAt: number;
    lastWakeDetectedAt: number | null;
    conversationStartedAt: number | null;
    conversationEndedAt: number | null;
    lastWakewordModel: string | null;
    lastWakewordScore: string | null;
    lastConversationEndReason: string | null;
    endedAt: number | null;
    endReason: string | null;
  } | null;
}

export interface DevicePairingSummary {
  pairingId: string;
  deviceId: string;
  familyId: string;
  elderId: string;
  ownerUserId: string;
  claimedByUserId: string;
  displayName: string | null;
  status: DevicePairingStatus;
  expiresAt: number;
  completedAt: number | null;
  metadata: Record<string, unknown>;
}

interface ResolvedFamilyContext {
  familyId: string;
  ownerUserId: string;
  claimedByUserId: string;
  elderId: string | null;
  elderName: string | null;
  elderLanguage: string | null;
}

const CLAIM_TTL_MS = 10 * 60 * 1000;
const PAIRING_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LANGUAGE = 'hi-IN';
const DEFAULT_RECONNECT_WINDOW_SEC = 180;
const DEFAULT_HEARTBEAT_INTERVAL_SEC = 15;
const DEFAULT_TELEMETRY_BACKOFF_SEC = 30;

const hashOpaqueToken = (value: string): string => createHash('sha256').update(value).digest('hex');
const createOpaqueToken = (bytes = 32): string => randomBytes(bytes).toString('hex');
const createClaimCode = (): string => (Math.floor(Math.random() * 900000) + 100000).toString();
const toDate = (value: number): Date => new Date(value);
const slug = (input: string): string => input.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'device';

const normalizeMetadata = (value: Record<string, unknown> | null | undefined): Record<string, unknown> => value ?? {};

const toMillis = (value: Date | null | undefined): number | null => value?.getTime() ?? null;

const readMetadataString = (metadata: Record<string, unknown>, key: string): string | null => {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const pickMetadataValue = (metadata: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(metadata, key) ? metadata[key] : undefined;

export class DeviceControlService {
  private readonly familyRepo = getFamilyRepository();

  private async resolveFamilyContextForUser(
    userId: string,
    elderId?: string,
    options: { requireElder?: boolean } = {}
  ): Promise<ResolvedFamilyContext> {
    const requireElder = options.requireElder ?? true;
    const family = (await this.familyRepo.getFamilyByUser(userId)) ?? (await this.familyRepo.getOrCreateFamilyForOwner(userId));
    const claimedByUserId = userId;

    let elderRow: typeof elderProfiles.$inferSelect | undefined;
    if (elderId) {
      [elderRow] = await db
        .select()
        .from(elderProfiles)
        .where(and(eq(elderProfiles.id, elderId), eq(elderProfiles.familyId, family.id)))
        .limit(1);
      if (!elderRow) {
        throw new Error('Selected elder profile does not belong to your family account');
      }
    } else {
      [elderRow] = await db.select().from(elderProfiles).where(eq(elderProfiles.familyId, family.id)).limit(1);
      if (!elderRow && requireElder) {
        throw new Error('Create the elder profile before pairing a device');
      }
    }

    return {
      familyId: family.id,
      ownerUserId: family.ownerUserId,
      claimedByUserId,
      elderId: elderRow?.id ?? null,
      elderName: elderRow?.name ?? null,
      elderLanguage: elderRow?.language ?? null
    };
  }

  private async canUserAccessFamilyResource(userId: string, familyId: string | null): Promise<boolean> {
    if (!familyId) return false;
    const family = await this.familyRepo.getFamilyByUser(userId);
    return family?.id === familyId;
  }

  private pairingSummary(row: typeof devicePairings.$inferSelect): DevicePairingSummary {
    return {
      pairingId: row.id,
      deviceId: row.deviceId,
      familyId: row.familyId,
      elderId: row.elderId,
      ownerUserId: row.ownerUserId,
      claimedByUserId: row.claimedByUserId,
      displayName: row.displayName,
      status: row.status,
      expiresAt: row.expiresAt.getTime(),
      completedAt: row.completedAt?.getTime() ?? null,
      metadata: normalizeMetadata(row.metadataJson)
    };
  }

  private sessionRecord(row: typeof deviceSessions.$inferSelect): DeviceSessionRecord {
    return {
      id: row.id,
      deviceId: row.deviceId,
      userId: row.userId,
      familyId: row.familyId,
      elderId: row.elderId,
      claimedByUserId: row.claimedByUserId,
      roomName: row.roomName,
      participantIdentity: row.participantIdentity,
      language: row.language,
      firmwareVersion: row.firmwareVersion,
      hardwareRev: row.hardwareRev,
      status: row.status,
      conversationState: row.conversationState,
      metadata: normalizeMetadata(row.metadataJson),
      startedAt: row.startedAt.getTime(),
      lastHeartbeatAt: row.lastHeartbeatAt.getTime(),
      lastWakeDetectedAt: toMillis(row.lastWakeDetectedAt),
      conversationStartedAt: toMillis(row.conversationStartedAt),
      conversationEndedAt: toMillis(row.conversationEndedAt),
      lastWakewordModel: row.lastWakewordModel ?? null,
      lastWakewordScore: row.lastWakewordScore ?? null,
      lastConversationEndReason: row.lastConversationEndReason ?? null,
      endedAt: toMillis(row.endedAt),
      endReason: row.endReason ?? null
    };
  }

  private async publishSessionState(row: typeof deviceSessions.$inferSelect, type: 'session_upserted' | 'session_ended' | 'conversation_state_changed'): Promise<void> {
    await publishDeviceSessionEvent({
      type,
      sessionId: row.id,
      deviceId: row.deviceId,
      roomName: row.roomName,
      participantIdentity: row.participantIdentity,
      status: row.status,
      conversationState: row.conversationState,
      ts: Date.now()
    });
  }

  private async getSessionRowById(sessionId: string): Promise<typeof deviceSessions.$inferSelect | null> {
    const [session] = await db.select().from(deviceSessions).where(eq(deviceSessions.id, sessionId)).limit(1);
    return session ?? null;
  }

  async getCurrentFamilyContextForUser(
    userId: string
  ): Promise<{ familyId: string; elderId: string | null } | null> {
    const context = await this.resolveFamilyContextForUser(userId, undefined, { requireElder: false });
    return {
      familyId: context.familyId,
      elderId: context.elderId
    };
  }

  async getLatestActivePairingForUser(userId: string): Promise<DevicePairingSummary | null> {
    const context = await this.resolveFamilyContextForUser(userId, undefined, { requireElder: false });
    const now = new Date();
    const filters = [
      eq(devicePairings.familyId, context.familyId),
      inArray(devicePairings.status, ['pending_device', 'bootstrapping']),
      gt(devicePairings.expiresAt, now)
    ];

    if (context.elderId) {
      filters.push(eq(devicePairings.elderId, context.elderId));
    }

    const [row] = await db
      .select()
      .from(devicePairings)
      .where(and(...filters))
      .orderBy(desc(devicePairings.createdAt))
      .limit(1);

    return row ? this.pairingSummary(row) : null;
  }

  async listDevicesForUser(userId: string): Promise<ClaimedDeviceSummary[]> {
    const family = await this.familyRepo.getFamilyByUser(userId);
    const whereClause = family
      ? or(
          eq(devices.familyId, family.id),
          eq(devices.userId, family.ownerUserId),
          eq(devices.claimedByUserId, userId)
        )
      : or(eq(devices.userId, userId), eq(devices.claimedByUserId, userId));

    const rows = await db.select().from(devices).where(whereClause).orderBy(desc(devices.claimedAt));
    if (rows.length === 0) return [];

    const deviceIds = rows.map((row) => row.deviceId);
    const sessions = await db
      .select()
      .from(deviceSessions)
      .where(inArray(deviceSessions.deviceId, deviceIds))
      .orderBy(desc(deviceSessions.startedAt));

    const latestSessionByDevice = new Map<string, (typeof deviceSessions.$inferSelect)>();
    for (const session of sessions) {
      if (!latestSessionByDevice.has(session.deviceId)) {
        latestSessionByDevice.set(session.deviceId, session);
      }
    }

    return rows.map((row) => {
      const lastSession = latestSessionByDevice.get(row.deviceId) ?? null;
      return {
        deviceId: row.deviceId,
        userId: row.userId,
        familyId: row.familyId,
        elderId: row.elderId,
        claimedByUserId: row.claimedByUserId,
        displayName: row.displayName,
        hardwareRev: row.hardwareRev,
        firmwareVersion: row.firmwareVersion,
        claimedAt: row.claimedAt.getTime(),
        lastSeenAt: row.lastSeenAt?.getTime() ?? null,
        revokedAt: row.revokedAt?.getTime() ?? null,
        metadata: normalizeMetadata(row.metadataJson),
        lastSession: lastSession
          ? {
              id: lastSession.id,
              roomName: lastSession.roomName,
              participantIdentity: lastSession.participantIdentity,
              status: lastSession.status,
              conversationState: lastSession.conversationState,
              startedAt: lastSession.startedAt.getTime(),
              lastHeartbeatAt: lastSession.lastHeartbeatAt.getTime(),
              lastWakeDetectedAt: toMillis(lastSession.lastWakeDetectedAt),
              conversationStartedAt: toMillis(lastSession.conversationStartedAt),
              conversationEndedAt: toMillis(lastSession.conversationEndedAt),
              lastWakewordModel: lastSession.lastWakewordModel ?? null,
              lastWakewordScore: lastSession.lastWakewordScore ?? null,
              lastConversationEndReason: lastSession.lastConversationEndReason ?? null,
              endedAt: lastSession.endedAt?.getTime() ?? null,
              endReason: lastSession.endReason ?? null
            }
          : null
      };
    });
  }

  async revokeDeviceForUser(userId: string, deviceId: string): Promise<boolean> {
    const [device] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.deviceId, deviceId), isNull(devices.revokedAt)))
      .limit(1);

    if (!device) return false;

    const canAccess = device.familyId
      ? await this.canUserAccessFamilyResource(userId, device.familyId)
      : device.userId === userId || device.claimedByUserId === userId;
    if (!canAccess) return false;

    const now = new Date();
    await db
      .update(devices)
      .set({
        revokedAt: now,
        updatedAt: now
      })
      .where(eq(devices.id, device.id));

    await db
      .update(deviceSessions)
      .set({
        status: 'ended',
        endedAt: now,
        endReason: 'device_revoked'
      })
      .where(and(eq(deviceSessions.deviceId, device.deviceId), or(eq(deviceSessions.status, 'issued'), eq(deviceSessions.status, 'active'))));

    return true;
  }

  async startClaim(userId: string): Promise<{ claimId: string; claimCode: string; expiresAt: number }> {
    const claimCode = createClaimCode();
    const expiresAt = Date.now() + CLAIM_TTL_MS;
    const [created] = await db
      .insert(deviceClaims)
      .values({
        userId,
        codeHash: hashOpaqueToken(claimCode),
        expiresAt: toDate(expiresAt)
      })
      .returning({ id: deviceClaims.id });

    return {
      claimId: created.id,
      claimCode,
      expiresAt
    };
  }

  async startPairing(input: {
    userId: string;
    elderId?: string;
    deviceId: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
  }): Promise<DevicePairingSummary & { pairingToken: string; elderName: string | null }> {
    const deviceId = input.deviceId.trim();
    if (!deviceId) {
      throw new Error('deviceId is required');
    }

    const familyContext = await this.resolveFamilyContextForUser(input.userId, input.elderId, { requireElder: true });
    if (!familyContext.elderId) {
      throw new Error('Create the elder profile before pairing a device');
    }

    const [existing] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (existing && !existing.revokedAt) {
      const sameFamily = existing.familyId
        ? existing.familyId === familyContext.familyId
        : existing.userId === familyContext.ownerUserId;
      if (!sameFamily) {
        throw new Error('Device is already claimed by another family');
      }
    }

    const now = new Date();
    await db
      .update(devicePairings)
      .set({
        status: 'revoked',
        updatedAt: now
      })
      .where(
        and(
          eq(devicePairings.deviceId, deviceId),
          or(eq(devicePairings.status, 'pending_device'), eq(devicePairings.status, 'bootstrapping'))
        )
      );

    const pairingToken = createOpaqueToken(24);
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const metadata = {
      pairedVia: 'ble_qr',
      qrVersion: 'v1',
      transport: 'ble',
      ...normalizeMetadata(input.metadata)
    };

    const [created] = await db
      .insert(devicePairings)
      .values({
        pairingTokenHash: hashOpaqueToken(pairingToken),
        deviceId,
        familyId: familyContext.familyId,
        elderId: familyContext.elderId,
        ownerUserId: familyContext.ownerUserId,
        claimedByUserId: familyContext.claimedByUserId,
        displayName: input.displayName?.trim() || null,
        status: 'pending_device',
        expiresAt: toDate(expiresAt),
        metadataJson: metadata
      })
      .returning();

    return {
      ...this.pairingSummary(created),
      pairingToken,
      elderName: familyContext.elderName
    };
  }

  async getPairingStatusForUser(userId: string, pairingId: string): Promise<DevicePairingSummary> {
    const [pairing] = await db.select().from(devicePairings).where(eq(devicePairings.id, pairingId)).limit(1);
    if (!pairing) {
      throw new Error('Pairing request not found');
    }

    const canAccess = await this.canUserAccessFamilyResource(userId, pairing.familyId);
    if (!canAccess) {
      throw new Error('Pairing request not found');
    }

    if (pairing.status === 'pending_device' && pairing.expiresAt.getTime() <= Date.now()) {
      await db
        .update(devicePairings)
        .set({
          status: 'expired',
          updatedAt: new Date()
        })
        .where(eq(devicePairings.id, pairing.id));
      pairing.status = 'expired';
    }

    return this.pairingSummary(pairing);
  }

  async completeClaim(input: {
    claimCode: string;
    deviceId: string;
    displayName?: string;
    hardwareRev?: string;
    firmwareVersion?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    deviceId: string;
    deviceAccessToken: string;
    userId: string;
    familyId: string | null;
    elderId: string | null;
    claimedByUserId: string | null;
    hardwareRev: string | null;
    firmwareVersion: string | null;
  }> {
    const codeHash = hashOpaqueToken(input.claimCode);
    const [claim] = await db
      .select()
      .from(deviceClaims)
      .where(and(eq(deviceClaims.codeHash, codeHash), isNull(deviceClaims.consumedAt)))
      .limit(1);

    if (!claim || claim.expiresAt.getTime() <= Date.now()) {
      throw new Error('Invalid or expired claim code');
    }

    const deviceId = input.deviceId.trim();
    if (!deviceId) {
      throw new Error('deviceId is required');
    }

    const familyContext = await this.resolveFamilyContextForUser(claim.userId, undefined, { requireElder: false }).catch(() => null);
    const ownerUserId = familyContext?.ownerUserId ?? claim.userId;
    const familyId = familyContext?.familyId ?? null;
    const elderId = familyContext?.elderId ?? null;
    const claimedByUserId = claim.userId;

    const [existing] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (existing && !existing.revokedAt) {
      const sameFamily = familyId
        ? existing.familyId === familyId || existing.userId === ownerUserId
        : existing.userId === ownerUserId;
      if (!sameFamily) {
        throw new Error('Device is already claimed by another user');
      }
    }

    const deviceAccessToken = createOpaqueToken(32);
    const nextMetadata = {
      ...normalizeMetadata(existing?.metadataJson),
      ...normalizeMetadata(input.metadata),
      claimMethod: 'legacy_code'
    };

    if (existing) {
      await db
        .update(devices)
        .set({
          userId: ownerUserId,
          familyId,
          elderId,
          claimedByUserId,
          displayName: input.displayName?.trim() || existing.displayName,
          hardwareRev: input.hardwareRev?.trim() || existing.hardwareRev,
          firmwareVersion: input.firmwareVersion?.trim() || existing.firmwareVersion,
          deviceAccessTokenHash: hashOpaqueToken(deviceAccessToken),
          metadataJson: nextMetadata,
          revokedAt: null,
          updatedAt: new Date(),
          lastSeenAt: new Date()
        })
        .where(eq(devices.id, existing.id));
    } else {
      await db.insert(devices).values({
        deviceId,
        userId: ownerUserId,
        familyId,
        elderId,
        claimedByUserId,
        displayName: input.displayName?.trim() || null,
        hardwareRev: input.hardwareRev?.trim() || null,
        firmwareVersion: input.firmwareVersion?.trim() || null,
        deviceAccessTokenHash: hashOpaqueToken(deviceAccessToken),
        metadataJson: nextMetadata,
        lastSeenAt: new Date()
      });
    }

    await db.update(deviceClaims).set({ consumedAt: new Date() }).where(eq(deviceClaims.id, claim.id));

    return {
      deviceId,
      deviceAccessToken,
      userId: ownerUserId,
      familyId,
      elderId,
      claimedByUserId,
      hardwareRev: input.hardwareRev?.trim() || existing?.hardwareRev || null,
      firmwareVersion: input.firmwareVersion?.trim() || existing?.firmwareVersion || null
    };
  }

  async completeBootstrap(input: {
    pairingToken: string;
    deviceId: string;
    displayName?: string;
    hardwareRev?: string;
    firmwareVersion?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    deviceId: string;
    deviceAccessToken: string;
    userId: string;
    familyId: string;
    elderId: string;
    claimedByUserId: string;
    hardwareRev: string | null;
    firmwareVersion: string | null;
  }> {
    const tokenHash = hashOpaqueToken(input.pairingToken);
    const [pairing] = await db
      .select()
      .from(devicePairings)
      .where(and(eq(devicePairings.pairingTokenHash, tokenHash), or(eq(devicePairings.status, 'pending_device'), eq(devicePairings.status, 'bootstrapping'))))
      .limit(1);

    if (!pairing) {
      throw new Error('Invalid or expired pairing token');
    }
    if (pairing.expiresAt.getTime() <= Date.now()) {
      await db
        .update(devicePairings)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(devicePairings.id, pairing.id));
      throw new Error('Invalid or expired pairing token');
    }

    const deviceId = input.deviceId.trim();
    if (!deviceId || deviceId !== pairing.deviceId) {
      throw new Error('Device ID does not match pairing request');
    }

    const [existing] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (existing && !existing.revokedAt) {
      const sameFamily = existing.familyId
        ? existing.familyId === pairing.familyId
        : existing.userId === pairing.ownerUserId;
      if (!sameFamily) {
        throw new Error('Device is already claimed by another family');
      }
    }

    const deviceAccessToken = createOpaqueToken(32);
    const now = new Date();
    const nextMetadata = {
      ...normalizeMetadata(existing?.metadataJson),
      ...normalizeMetadata(pairing.metadataJson),
      ...normalizeMetadata(input.metadata),
      pairingId: pairing.id,
      pairingCompletedAt: now.toISOString(),
      pairedVia: 'ble_qr'
    };

    if (existing) {
      await db
        .update(devices)
        .set({
          userId: pairing.ownerUserId,
          familyId: pairing.familyId,
          elderId: pairing.elderId,
          claimedByUserId: pairing.claimedByUserId,
          displayName: input.displayName?.trim() || pairing.displayName || existing.displayName,
          hardwareRev: input.hardwareRev?.trim() || existing.hardwareRev,
          firmwareVersion: input.firmwareVersion?.trim() || existing.firmwareVersion,
          deviceAccessTokenHash: hashOpaqueToken(deviceAccessToken),
          metadataJson: nextMetadata,
          revokedAt: null,
          updatedAt: now,
          lastSeenAt: now
        })
        .where(eq(devices.id, existing.id));
    } else {
      await db.insert(devices).values({
        deviceId,
        userId: pairing.ownerUserId,
        familyId: pairing.familyId,
        elderId: pairing.elderId,
        claimedByUserId: pairing.claimedByUserId,
        displayName: input.displayName?.trim() || pairing.displayName || null,
        hardwareRev: input.hardwareRev?.trim() || null,
        firmwareVersion: input.firmwareVersion?.trim() || null,
        deviceAccessTokenHash: hashOpaqueToken(deviceAccessToken),
        metadataJson: nextMetadata,
        lastSeenAt: now
      });
    }

    await db
      .update(devicePairings)
      .set({
        status: 'completed',
        completedAt: now,
        updatedAt: now
      })
      .where(eq(devicePairings.id, pairing.id));

    return {
      deviceId,
      deviceAccessToken,
      userId: pairing.ownerUserId,
      familyId: pairing.familyId,
      elderId: pairing.elderId,
      claimedByUserId: pairing.claimedByUserId,
      hardwareRev: input.hardwareRev?.trim() || existing?.hardwareRev || null,
      firmwareVersion: input.firmwareVersion?.trim() || existing?.firmwareVersion || null
    };
  }

  async getDeviceFromAccessToken(accessToken: string): Promise<DeviceAuthRecord | null> {
    const hash = hashOpaqueToken(accessToken);
    const [device] = await db
      .select()
      .from(devices)
      .where(and(eq(devices.deviceAccessTokenHash, hash), isNull(devices.revokedAt)))
      .limit(1);

    if (!device) return null;

    return {
      id: device.id,
      deviceId: device.deviceId,
      userId: device.userId,
      familyId: device.familyId,
      elderId: device.elderId,
      claimedByUserId: device.claimedByUserId,
      displayName: device.displayName,
      hardwareRev: device.hardwareRev,
      firmwareVersion: device.firmwareVersion,
      metadataJson: normalizeMetadata(device.metadataJson)
    };
  }

  async mintLiveKitToken(input: {
    device: DeviceAuthRecord;
    language?: string;
    firmwareVersion?: string;
    hardwareRev?: string;
    roomName?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    sessionId: string;
    serverUrl: string;
    participantToken: string;
    roomName: string;
    identity: string;
    agentName: string;
    dispatchMetadata: Record<string, unknown>;
    participantTokenExpiresAtMs: number;
  }> {
    const livekit = getRequiredLivekitConfig();
    if (!livekit) {
      throw new Error('LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.');
    }

    // Persistent warm connection model: every token for a given device maps to
    // the same stable room. The device joins this room once at boot and stays
    // connected until reboot, so sessionId represents a connection lifecycle
    // rather than a single wake-turn.
    const stableRoomName = `mitr-persistent-${slug(input.device.deviceId)}`;
    const roomName = input.roomName?.trim() || stableRoomName;
    // Keep the identity stable per device so repeated token mints don't create
    // ghost participants in the room.
    const identity = `device-${slug(input.device.deviceId)}`;
    const metadataLanguage = readMetadataString(input.device.metadataJson, 'elderLanguage');
    const language = input.language?.trim() || metadataLanguage || DEFAULT_LANGUAGE;
    const firmwareVersion = input.firmwareVersion?.trim() || input.device.firmwareVersion || null;
    const hardwareRev = input.hardwareRev?.trim() || input.device.hardwareRev || null;

    const at = new AccessToken(livekit.apiKey, livekit.apiSecret, {
      identity,
      ttl: livekit.tokenTtlSec
    });
    const participantTokenExpiresAtMs = Date.now() + livekit.tokenTtlSec * 1000;
    const videoGrant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    };
    at.addGrant(videoGrant);

    const metadataBase = {
      user_id: input.device.userId,
      family_id: input.device.familyId,
      elder_id: input.device.elderId,
      claimed_by_user_id: input.device.claimedByUserId,
      device_id: input.device.deviceId,
      language,
      firmware_version: firmwareVersion,
      hardware_rev: hardwareRev,
      ...(input.metadata ?? {})
    };

    const participantToken = await at.toJwt();

    // Reuse an existing active session row if we already have one for this
    // device + room. Under the persistent-warm model a device typically lives
    // in a single session until reboot; tearing prior sessions down on every
    // mint caused the device log churn (and the transient `used_prefetch=0`
    // retry loop) documented in the 2026-04-17 trace.
    const [existingSession] = await db
      .select({ id: deviceSessions.id })
      .from(deviceSessions)
      .where(
        and(
          eq(deviceSessions.deviceId, input.device.deviceId),
          eq(deviceSessions.roomName, roomName),
          inArray(deviceSessions.status, ['issued', 'active'])
        )
      )
      .orderBy(desc(deviceSessions.startedAt))
      .limit(1);

    let sessionId: string;
    if (existingSession) {
      sessionId = existingSession.id;
      const dispatchMetadata = {
        ...metadataBase,
        session_id: sessionId
      };
      await db
        .update(deviceSessions)
        .set({
          participantIdentity: identity,
          language,
          firmwareVersion,
          hardwareRev,
          metadataJson: dispatchMetadata,
          lastHeartbeatAt: new Date()
        })
        .where(eq(deviceSessions.id, existingSession.id));
    } else {
      const [session] = await db
        .insert(deviceSessions)
        .values({
          deviceId: input.device.deviceId,
          userId: input.device.userId,
          familyId: input.device.familyId,
          elderId: input.device.elderId,
          claimedByUserId: input.device.claimedByUserId,
          roomName,
          participantIdentity: identity,
          language,
          firmwareVersion,
          hardwareRev,
          status: 'issued',
          conversationState: 'idle',
          metadataJson: metadataBase
        })
        .returning({ id: deviceSessions.id });
      sessionId = session.id;
      const dispatchMetadata = {
        ...metadataBase,
        session_id: sessionId
      };
      await db
        .update(deviceSessions)
        .set({
          metadataJson: dispatchMetadata
        })
        .where(eq(deviceSessions.id, sessionId));
    }

    await db
      .update(devices)
      .set({
        firmwareVersion,
        hardwareRev,
        lastSeenAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(devices.id, input.device.id));

    const sessionRow = await this.getSessionRowById(sessionId);
    if (sessionRow) {
      await this.publishSessionState(sessionRow, 'session_upserted');
    }

    const dispatchMetadata = {
      ...metadataBase,
      session_id: sessionId
    };

    return {
      sessionId,
      serverUrl: livekit.url,
      participantToken,
      roomName,
      identity,
      agentName: livekit.agentName,
      dispatchMetadata,
      participantTokenExpiresAtMs
    };
  }

  /**
   * Mint a fresh participant JWT for a device's persistent room without
   * creating a new session row. Used by the firmware's background token
   * refresh task to extend credentials before they expire.
   */
  async refreshLiveKitToken(input: {
    device: DeviceAuthRecord;
  }): Promise<{
    sessionId: string;
    serverUrl: string;
    participantToken: string;
    roomName: string;
    identity: string;
    participantTokenExpiresAtMs: number;
  }> {
    const livekit = getRequiredLivekitConfig();
    if (!livekit) {
      throw new Error('LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.');
    }

    const roomName = `mitr-persistent-${slug(input.device.deviceId)}`;
    const identity = `device-${slug(input.device.deviceId)}`;

    const [existingSession] = await db
      .select({ id: deviceSessions.id })
      .from(deviceSessions)
      .where(
        and(
          eq(deviceSessions.deviceId, input.device.deviceId),
          eq(deviceSessions.roomName, roomName),
          inArray(deviceSessions.status, ['issued', 'active'])
        )
      )
      .orderBy(desc(deviceSessions.startedAt))
      .limit(1);

    if (!existingSession) {
      throw new Error('No active session to refresh; call /devices/token instead');
    }

    const at = new AccessToken(livekit.apiKey, livekit.apiSecret, {
      identity,
      ttl: livekit.tokenTtlSec
    });
    const participantTokenExpiresAtMs = Date.now() + livekit.tokenTtlSec * 1000;
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    } as VideoGrant);

    // Token refresh keeps the persistent device participant alive only.
    // Agent dispatch is now explicit and wake-driven.

    const participantToken = await at.toJwt();

    await db
      .update(deviceSessions)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(deviceSessions.id, existingSession.id));

    return {
      sessionId: existingSession.id,
      serverUrl: livekit.url,
      participantToken,
      roomName,
      identity,
      participantTokenExpiresAtMs
    };
  }

  async listLiveDeviceSessions(): Promise<DeviceSessionRecord[]> {
    const rows = await db
      .select()
      .from(deviceSessions)
      .where(inArray(deviceSessions.status, ['issued', 'active']))
      .orderBy(desc(deviceSessions.startedAt));
    return rows.map((row) => this.sessionRecord(row));
  }

  async getDeviceSession(sessionId: string): Promise<DeviceSessionRecord | null> {
    const row = await this.getSessionRowById(sessionId);
    return row ? this.sessionRecord(row) : null;
  }

  async dispatchAgentToPersistentRoom(sessionId: string): Promise<void> {
    const session = await this.getSessionRowById(sessionId);
    if (!session) {
      throw new Error('Device session not found');
    }

    const livekit = getRequiredLivekitConfig();
    if (!livekit) {
      throw new Error('LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.');
    }

    const dispatchClient = new AgentDispatchClient(livekit.url, livekit.apiKey, livekit.apiSecret);
    await dispatchClient.createDispatch(session.roomName, livekit.agentName, {
      metadata: JSON.stringify(normalizeMetadata(session.metadataJson))
    });
  }

  async handleWakeDetected(input: {
    sessionId: string;
    modelName: string;
    phrase: string;
    score: number;
    detectedAtMs: number;
  }): Promise<{ accepted: boolean; reason?: string; session: DeviceSessionRecord | null }> {
    const session = await this.getSessionRowById(input.sessionId);
    if (!session) {
      return { accepted: false, reason: 'session_not_found', session: null };
    }
    if (!['issued', 'active'].includes(session.status)) {
      return { accepted: false, reason: 'session_not_live', session: this.sessionRecord(session) };
    }
    if (session.conversationState !== 'idle') {
      return { accepted: false, reason: 'conversation_not_idle', session: this.sessionRecord(session) };
    }

    const wakeDetectedAt = new Date(input.detectedAtMs);
    const metadata = {
      ...normalizeMetadata(session.metadataJson),
      last_wakeword_phrase: input.phrase
    };
    await db
      .update(deviceSessions)
      .set({
        conversationState: 'starting',
        lastWakeDetectedAt: wakeDetectedAt,
        lastWakewordModel: input.modelName,
        lastWakewordScore: String(input.score),
        metadataJson: metadata
      })
      .where(eq(deviceSessions.id, input.sessionId));

    try {
      await this.dispatchAgentToPersistentRoom(input.sessionId);
    } catch (error) {
      await db
        .update(deviceSessions)
        .set({
          conversationState: 'idle',
          lastConversationEndReason: 'dispatch_failed',
          conversationEndedAt: new Date()
        })
        .where(eq(deviceSessions.id, input.sessionId));
      const failedSession = await this.getSessionRowById(input.sessionId);
      if (failedSession) {
        await this.publishSessionState(failedSession, 'conversation_state_changed');
      }
      throw error;
    }

    const updated = await this.getSessionRowById(input.sessionId);
    if (updated) {
      await this.publishSessionState(updated, 'conversation_state_changed');
    }
    return {
      accepted: true,
      session: updated ? this.sessionRecord(updated) : null
    };
  }

  async markConversationActive(sessionId: string): Promise<DeviceSessionRecord | null> {
    await db
      .update(deviceSessions)
      .set({
        conversationState: 'active',
        conversationStartedAt: new Date()
      })
      .where(and(eq(deviceSessions.id, sessionId), inArray(deviceSessions.conversationState, ['starting', 'active'])));

    const session = await this.getSessionRowById(sessionId);
    if (session) {
      await this.publishSessionState(session, 'conversation_state_changed');
      return this.sessionRecord(session);
    }
    return null;
  }

  async markConversationEnded(sessionId: string, reason: string): Promise<DeviceSessionRecord | null> {
    await db
      .update(deviceSessions)
      .set({
        conversationState: 'ending',
        lastConversationEndReason: reason,
        conversationEndedAt: new Date()
      })
      .where(and(eq(deviceSessions.id, sessionId), inArray(deviceSessions.status, ['issued', 'active'])));

    await db
      .update(deviceSessions)
      .set({
        conversationState: 'idle',
        lastConversationEndReason: reason,
        conversationEndedAt: new Date()
      })
      .where(eq(deviceSessions.id, sessionId));

    const session = await this.getSessionRowById(sessionId);
    if (session) {
      await this.publishSessionState(session, 'conversation_state_changed');
      return this.sessionRecord(session);
    }
    return null;
  }

  async markConversationError(sessionId: string, reason: string): Promise<DeviceSessionRecord | null> {
    await db
      .update(deviceSessions)
      .set({
        conversationState: 'idle',
        lastConversationEndReason: reason,
        conversationEndedAt: new Date()
      })
      .where(eq(deviceSessions.id, sessionId));

    const session = await this.getSessionRowById(sessionId);
    if (session) {
      await this.publishSessionState(session, 'conversation_state_changed');
      return this.sessionRecord(session);
    }
    return null;
  }

  async heartbeat(input: {
    device: DeviceAuthRecord;
    sessionId?: string;
    firmwareVersion?: string;
    payload?: Record<string, unknown>;
  }): Promise<{
    ok: true;
    recommendedFirmware: {
      version: string;
      downloadUrl: string | null;
      mandatory: boolean;
      releaseNotes: string | null;
      metadata: Record<string, unknown>;
    } | null;
    sessionPolicy: {
      alwaysConnected: true;
      reconnectWindowSec: number;
      heartbeatIntervalSec: number;
      telemetryBackoffSec: number;
    };
  }> {
    const now = new Date();
    const payload = input.payload ?? {};
    const metadata: Record<string, unknown> = {
      ...normalizeMetadata(input.device.metadataJson),
      lastHeartbeat: payload
    };
    for (const key of [
      'lastFailureReason',
      'reconnectState',
      'reconnectAttemptCount',
      'lastEndReason',
      'otaState',
      'otaTargetVersion',
      'lastBootOk',
      'speakerMuted',
      'speakerVolume'
    ]) {
      const value = pickMetadataValue(payload, key);
      if (value !== undefined) {
        metadata[key] = value;
      }
    }

    await db
      .update(devices)
      .set({
        firmwareVersion: input.firmwareVersion?.trim() || input.device.firmwareVersion,
        lastSeenAt: now,
        updatedAt: now,
        metadataJson: metadata
      })
      .where(eq(devices.id, input.device.id));

    if (input.sessionId) {
      await db
        .update(deviceSessions)
        .set({
          status: 'active',
          lastHeartbeatAt: now,
          firmwareVersion: input.firmwareVersion?.trim() || input.device.firmwareVersion
        })
        .where(and(eq(deviceSessions.id, input.sessionId), eq(deviceSessions.deviceId, input.device.deviceId)));

      const session = await this.getSessionRowById(input.sessionId);
      if (session) {
        await this.publishSessionState(session, 'session_upserted');
      }
    }

    const [recommended] = await db
      .select()
      .from(firmwareReleases)
      .where(
        and(
          eq(firmwareReleases.isActive, true),
          input.device.hardwareRev
            ? eq(firmwareReleases.hardwareRev, input.device.hardwareRev)
            : or(eq(firmwareReleases.hardwareRev, 'unknown'), eq(firmwareReleases.hardwareRev, 'default'))
        )
      )
      .orderBy(desc(firmwareReleases.publishedAt))
      .limit(1);

    return {
      ok: true,
      recommendedFirmware: recommended
        ? {
            version: recommended.version,
            downloadUrl: recommended.downloadUrl,
            mandatory: recommended.isMandatory,
            releaseNotes: recommended.releaseNotes,
            metadata: normalizeMetadata(recommended.metadataJson)
          }
        : null,
      sessionPolicy: {
        alwaysConnected: true,
        reconnectWindowSec: DEFAULT_RECONNECT_WINDOW_SEC,
        heartbeatIntervalSec: DEFAULT_HEARTBEAT_INTERVAL_SEC,
        telemetryBackoffSec: DEFAULT_TELEMETRY_BACKOFF_SEC
      }
    };
  }

  async appendTelemetry(input: {
    device: DeviceAuthRecord;
    sessionId?: string;
    eventType: string;
    level?: 'debug' | 'info' | 'warn' | 'error';
    payload?: Record<string, unknown>;
  }): Promise<{ ok: true }> {
    await db.insert(deviceTelemetry).values({
      deviceId: input.device.deviceId,
      userId: input.device.userId,
      familyId: input.device.familyId,
      elderId: input.device.elderId,
      claimedByUserId: input.device.claimedByUserId,
      sessionId: input.sessionId ?? null,
      eventType: input.eventType,
      level: input.level ?? 'info',
      payloadJson: input.payload ?? {}
    });

    await db
      .update(devices)
      .set({
        lastSeenAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(devices.id, input.device.id));

    return { ok: true };
  }

  async endSession(input: {
    device: DeviceAuthRecord;
    sessionId: string;
    reason?: string;
  }): Promise<{ ok: true }> {
    await db
      .update(deviceSessions)
      .set({
        status: 'ended',
        conversationState: 'idle',
        conversationEndedAt: new Date(),
        lastConversationEndReason: input.reason?.trim() || 'device_end',
        endedAt: new Date(),
        endReason: input.reason?.trim() || 'device_end'
      })
      .where(and(eq(deviceSessions.id, input.sessionId), eq(deviceSessions.deviceId, input.device.deviceId)));

    await db
      .update(devices)
      .set({
        lastSeenAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(devices.id, input.device.id));

    const session = await this.getSessionRowById(input.sessionId);
    if (session) {
      await this.publishSessionState(session, 'session_ended');
    }

    return { ok: true };
  }
}
