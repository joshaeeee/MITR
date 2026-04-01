import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { AccessToken, VideoGrant } from 'livekit-server-sdk';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import { db } from '../../db/client.js';
import {
  deviceClaims,
  devices,
  deviceSessions,
  deviceTelemetry,
  firmwareReleases
} from '../../db/schema.js';
import { getRequiredLivekitConfig } from '../../config/livekit-config.js';

export interface DeviceAuthRecord {
  id: string;
  deviceId: string;
  userId: string;
  displayName: string | null;
  hardwareRev: string | null;
  firmwareVersion: string | null;
  metadataJson: Record<string, unknown>;
}

export interface ClaimedDeviceSummary {
  deviceId: string;
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

const CLAIM_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LANGUAGE = 'hi-IN';

const hashOpaqueToken = (value: string): string => createHash('sha256').update(value).digest('hex');
const createOpaqueToken = (bytes = 32): string => randomBytes(bytes).toString('hex');
const createClaimCode = (): string => (Math.floor(Math.random() * 900000) + 100000).toString();
const toDate = (value: number): Date => new Date(value);
const slug = (input: string): string => input.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'device';

const normalizeMetadata = (value: Record<string, unknown> | null | undefined): Record<string, unknown> => value ?? {};

export class DeviceControlService {
  async listDevicesForUser(userId: string): Promise<ClaimedDeviceSummary[]> {
    const rows = await db.select().from(devices).where(eq(devices.userId, userId)).orderBy(desc(devices.claimedAt));
    if (rows.length === 0) return [];

    const deviceIds = rows.map((row) => row.deviceId);
    const sessions = await db
      .select()
      .from(deviceSessions)
      .where(and(eq(deviceSessions.userId, userId), inArray(deviceSessions.deviceId, deviceIds)))
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
      .where(and(eq(devices.userId, userId), eq(devices.deviceId, deviceId), isNull(devices.revokedAt)))
      .limit(1);

    if (!device) return false;

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
    hardwareRev: string | null;
    firmwareVersion: string | null;
  }> {
    const codeHash = hashOpaqueToken(input.claimCode);
    const [claim] = await db
      .select()
      .from(deviceClaims)
      .where(and(eq(deviceClaims.codeHash, codeHash), isNull(deviceClaims.consumedAt)))
      .limit(1);

    if (!claim) {
      throw new Error('Invalid or expired claim code');
    }
    if (claim.expiresAt.getTime() <= Date.now()) {
      throw new Error('Invalid or expired claim code');
    }

    const deviceId = input.deviceId.trim();
    if (!deviceId) {
      throw new Error('deviceId is required');
    }

    const [existing] = await db.select().from(devices).where(eq(devices.deviceId, deviceId)).limit(1);
    if (existing && existing.userId !== claim.userId && !existing.revokedAt) {
      throw new Error('Device is already claimed by another user');
    }

    const deviceAccessToken = createOpaqueToken(32);
    const nextMetadata = {
      ...normalizeMetadata(existing?.metadataJson),
      ...normalizeMetadata(input.metadata)
    };

    if (existing) {
      await db
        .update(devices)
        .set({
          userId: claim.userId,
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
        userId: claim.userId,
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
      userId: claim.userId,
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
    const language = input.language?.trim() || DEFAULT_LANGUAGE;
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
  }): Promise<{ ok: true; recommendedFirmware: { version: string; downloadUrl: string | null; mandatory: boolean } | null }> {
    const now = new Date();
    const metadata = {
      ...normalizeMetadata(input.device.metadataJson),
      lastHeartbeat: input.payload ?? {}
    };

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
            mandatory: recommended.isMandatory
          }
        : null
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
