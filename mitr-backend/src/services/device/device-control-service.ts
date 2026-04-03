import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { AccessToken, VideoGrant } from 'livekit-server-sdk';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
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

type DevicePairingStatus = 'pending_device' | 'bootstrapping' | 'completed' | 'expired' | 'revoked';

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
    startedAt: number;
    lastHeartbeatAt: number;
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
              startedAt: lastSession.startedAt.getTime(),
              lastHeartbeatAt: lastSession.lastHeartbeatAt.getTime(),
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
  }> {
    const livekit = getRequiredLivekitConfig();
    if (!livekit) {
      throw new Error('LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.');
    }

    const roomName = input.roomName?.trim() || `mitr-device-${slug(input.device.deviceId)}-${Date.now()}`;
    const identity = `device-${slug(input.device.deviceId)}-${Math.floor(Math.random() * 10_000)}`;
    const metadataLanguage = readMetadataString(input.device.metadataJson, 'elderLanguage');
    const language = input.language?.trim() || metadataLanguage || DEFAULT_LANGUAGE;
    const firmwareVersion = input.firmwareVersion?.trim() || input.device.firmwareVersion || null;
    const hardwareRev = input.hardwareRev?.trim() || input.device.hardwareRev || null;

    const at = new AccessToken(livekit.apiKey, livekit.apiSecret, {
      identity,
      ttl: livekit.tokenTtlSec
    });
    const videoGrant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    };
    at.addGrant(videoGrant);

    const dispatchMetadata = {
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

    at.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName: livekit.agentName,
          metadata: JSON.stringify(dispatchMetadata)
        })
      ]
    });

    const participantToken = await at.toJwt();

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
        metadataJson: dispatchMetadata
      })
      .returning({ id: deviceSessions.id });

    await db
      .update(devices)
      .set({
        firmwareVersion,
        hardwareRev,
        lastSeenAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(devices.id, input.device.id));

    return {
      sessionId: session.id,
      serverUrl: livekit.url,
      participantToken,
      roomName,
      identity,
      agentName: livekit.agentName,
      dispatchMetadata
    };
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
      'muted',
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

    return { ok: true };
  }
}
