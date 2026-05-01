import { DataPacket_Kind, RoomServiceClient } from 'livekit-server-sdk';
import { getRequiredLivekitConfig } from '../../config/livekit-config.js';
import { logger } from '../../lib/logger.js';

const DEVICE_CONTROL_TOPIC = 'mitr.device_control';

type DeviceControlPacketType =
  | 'agent_ready'
  | 'conversation_started'
  | 'conversation_ended'
  | 'conversation_error'
  | 'session_superseded';

export interface DeviceRoomSessionTarget {
  sessionId: string;
  roomName: string;
  participantIdentity: string;
  bootId: string;
}

const buildRoomServiceClient = (): RoomServiceClient | null => {
  try {
    const livekit = getRequiredLivekitConfig();
    if (!livekit) return null;
    return new RoomServiceClient(livekit.url, livekit.apiKey, livekit.apiSecret);
  } catch {
    return null;
  }
};

export const sendDeviceControlPacket = async (
  target: DeviceRoomSessionTarget,
  type: DeviceControlPacketType,
  payload: Record<string, unknown> = {},
  options: { destinationIdentities?: string[] | null } = {}
): Promise<void> => {
  const client = buildRoomServiceClient();
  if (!client) return;

  const body = {
    type,
    action: type,
    deviceSessionId: target.sessionId,
    sessionId: target.sessionId,
    bootId: target.bootId,
    ts: Date.now(),
    ...payload
  };

  await client.sendData(
    target.roomName,
    new TextEncoder().encode(JSON.stringify(body)),
    DataPacket_Kind.RELIABLE,
    {
      topic: DEVICE_CONTROL_TOPIC,
      ...(options.destinationIdentities === null
        ? {}
        : { destinationIdentities: options.destinationIdentities ?? [target.participantIdentity] })
    }
  );
};

export const removeDeviceParticipant = async (target: DeviceRoomSessionTarget): Promise<void> => {
  const client = buildRoomServiceClient();
  if (!client) return;
  await client.removeParticipant(target.roomName, target.participantIdentity);
};

export const notifyAndDetachSupersededSession = async (
  target: DeviceRoomSessionTarget,
  reason = 'session_superseded'
): Promise<void> => {
  try {
    await sendDeviceControlPacket(target, 'session_superseded', { reason });
  } catch (error) {
    logger.warn('Failed to publish session_superseded packet', {
      sessionId: target.sessionId,
      roomName: target.roomName,
      error: (error as Error).message
    });
  }

  try {
    await removeDeviceParticipant(target);
  } catch (error) {
    logger.warn('Failed to remove superseded device participant', {
      sessionId: target.sessionId,
      roomName: target.roomName,
      identity: target.participantIdentity,
      error: (error as Error).message
    });
  }
};

export const detachDeviceParticipant = async (
  target: DeviceRoomSessionTarget,
  reason: string
): Promise<void> => {
  try {
    await removeDeviceParticipant(target);
  } catch (error) {
    logger.warn('Failed to remove device participant', {
      sessionId: target.sessionId,
      roomName: target.roomName,
      identity: target.participantIdentity,
      reason,
      error: (error as Error).message
    });
  }
};
