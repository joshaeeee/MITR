import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceAuthRecord, DeviceControlService } from './device-control-service.js';

export interface DeviceAuthContext {
  device: DeviceAuthRecord;
  accessToken: string;
}

const parseBearer = (header?: string): string | null => {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
};

export const requireDeviceAuth =
  (devices: DeviceControlService) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = parseBearer(request.headers.authorization);
    if (!token) {
      void reply.status(401).send({ error: 'Missing device bearer token' });
      return;
    }

    const device = await devices.getDeviceFromAccessToken(token);
    if (!device) {
      void reply.status(401).send({ error: 'Invalid or revoked device token' });
      return;
    }

    request.deviceAuth = { device, accessToken: token };
  };
