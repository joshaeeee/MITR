import { getSharedRedisClient } from '../../lib/redis.js';

export const DEVICE_SESSION_EVENTS_CHANNEL = 'mitr:device-session-events';

export type DeviceSessionEventType =
  | 'session_upserted'
  | 'session_ended'
  | 'conversation_state_changed';

export interface DeviceSessionEventPayload {
  type: DeviceSessionEventType;
  sessionId: string;
  deviceId: string;
  roomName: string;
  participantIdentity: string;
  status: 'issued' | 'active' | 'ended';
  conversationState: 'idle' | 'starting' | 'active' | 'ending';
  ts: number;
}

export const publishDeviceSessionEvent = async (payload: DeviceSessionEventPayload): Promise<void> => {
  const redis = getSharedRedisClient();
  if (!redis) return;
  await redis.publish(DEVICE_SESSION_EVENTS_CHANNEL, JSON.stringify(payload));
};
