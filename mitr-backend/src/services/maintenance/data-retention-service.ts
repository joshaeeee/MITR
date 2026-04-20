import { and, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { authSessions, deviceConversations, devices, deviceSessions, otpChallenges, refreshTokens, userEventStream } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { detachDeviceParticipant } from '../device/livekit-device-room-control.js';

export class DataRetentionService {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (env.MAINTENANCE_CLEANUP_INTERVAL_SEC <= 0) {
      logger.info('Data retention cleanup disabled', {
        intervalSec: env.MAINTENANCE_CLEANUP_INTERVAL_SEC
      });
      return;
    }
    if (this.timer) return;

    const intervalMs = env.MAINTENANCE_CLEANUP_INTERVAL_SEC * 1000;
    this.timer = setInterval(() => {
      void this.runOnce('interval');
    }, intervalMs);
    this.timer.unref();

    void this.runOnce('startup');
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(reason: 'startup' | 'interval' | 'manual' = 'manual'): Promise<void> {
    const now = new Date();
    const revokedSessionCutoff = new Date(now.getTime() - env.AUTH_REVOKED_SESSION_RETENTION_SEC * 1000);
    const consumedOtpCutoff = new Date(now.getTime() - env.AUTH_OTP_CONSUMED_RETENTION_SEC * 1000);
    const eventCutoff = new Date(now.getTime() - env.USER_EVENT_STREAM_RETENTION_SEC * 1000);
    const deviceSessionCutoff = new Date(now.getTime() - env.DEVICE_SESSION_STALE_SEC * 1000);

    try {
      const endedDeviceSessions = env.DEVICE_SESSION_STALE_SEC > 0
        ? await db
            .update(deviceSessions)
            .set({
              status: 'ended',
              conversationState: 'idle',
              endedAt: now,
              endReason: 'heartbeat_timeout',
              lastConversationEndReason: 'heartbeat_timeout',
              conversationEndedAt: now
            })
            .where(
              and(
                inArray(deviceSessions.status, ['issued', 'active']),
                lt(deviceSessions.lastHeartbeatAt, deviceSessionCutoff)
              )
            )
            .returning({
              id: deviceSessions.id,
              deviceId: deviceSessions.deviceId,
              roomName: deviceSessions.roomName,
              participantIdentity: deviceSessions.participantIdentity,
              bootId: deviceSessions.bootId
            })
        : [];

      if (endedDeviceSessions.length > 0) {
        const endedIds = endedDeviceSessions.map((row) => row.id);
        await db
          .update(deviceConversations)
          .set({
            state: 'abandoned',
            endedAt: now,
            endReason: 'heartbeat_timeout'
          })
          .where(
            and(
              inArray(deviceConversations.deviceSessionId, endedIds),
              inArray(deviceConversations.state, ['opening', 'active'])
            )
          );

        for (const row of endedDeviceSessions) {
          await db
            .update(devices)
            .set({ currentDeviceSessionId: null })
            .where(and(eq(devices.deviceId, row.deviceId), eq(devices.currentDeviceSessionId, row.id)));
          await detachDeviceParticipant(
            {
              sessionId: row.id,
              roomName: row.roomName,
              participantIdentity: row.participantIdentity,
              bootId: row.bootId
            },
            'heartbeat_timeout'
          );
        }
      }

      const [deletedSessions, deletedRefreshTokens, deletedOtpChallenges, deletedUserEvents] = await Promise.all([
        db
          .delete(authSessions)
          .where(
            or(
              lt(authSessions.refreshExpiresAt, now),
              and(isNotNull(authSessions.revokedAt), lt(authSessions.revokedAt, revokedSessionCutoff))
            )
          )
          .returning({ id: authSessions.id }),
        db
          .delete(refreshTokens)
          .where(
            or(
              lt(refreshTokens.expiresAt, now),
              and(isNotNull(refreshTokens.revokedAt), lt(refreshTokens.revokedAt, revokedSessionCutoff))
            )
          )
          .returning({ id: refreshTokens.id }),
        db
          .delete(otpChallenges)
          .where(
            or(
              lt(otpChallenges.expiresAt, now),
              and(isNotNull(otpChallenges.consumedAt), lt(otpChallenges.consumedAt, consumedOtpCutoff))
            )
          )
          .returning({ id: otpChallenges.id }),
        db
          .delete(userEventStream)
          .where(lt(userEventStream.createdAt, eventCutoff))
          .returning({ id: userEventStream.id })
      ]);

      const deleted = {
        authSessions: deletedSessions.length,
        refreshTokens: deletedRefreshTokens.length,
        otpChallenges: deletedOtpChallenges.length,
        userEventStream: deletedUserEvents.length,
        deviceSessionsEnded: endedDeviceSessions.length
      };

      if (Object.values(deleted).some((count) => count > 0)) {
        logger.info('Data retention cleanup removed stale rows', { reason, deleted });
      } else {
        logger.debug('Data retention cleanup had no stale rows', { reason });
      }
    } catch (error) {
      logger.error('Data retention cleanup failed', {
        reason,
        error: (error as Error).message
      });
    }
  }
}
