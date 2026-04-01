import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { DeviceService } from '../services/device/device-service.js';
import { DeviceControlService } from '../services/device/device-control-service.js';
import { requireDeviceAuth } from '../services/device/device-auth.js';

const linkSchema = z.object({
  serialNumber: z.string().min(1),
  firmwareVersion: z.string().optional()
});

const claimCompleteSchema = z.object({
  claimCode: z.string().min(4),
  deviceId: z.string().min(1),
  displayName: z.string().optional(),
  hardwareRev: z.string().optional(),
  firmwareVersion: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

const deviceTokenSchema = z.object({
  language: z.string().optional(),
  roomName: z.string().optional(),
  firmwareVersion: z.string().optional(),
  hardwareRev: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

const deviceHeartbeatSchema = z.object({
  sessionId: z.string().uuid().optional(),
  firmwareVersion: z.string().optional(),
  wifiRssiDbm: z.number().int().optional(),
  batteryPct: z.number().min(0).max(100).optional(),
  networkType: z.string().optional(),
  ipAddress: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

const deviceTelemetrySchema = z.object({
  sessionId: z.string().uuid().optional(),
  eventType: z.string().min(1),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  payload: z.record(z.unknown()).optional()
});

const deviceSessionEndSchema = z.object({
  sessionId: z.string().uuid(),
  reason: z.string().optional()
});

const revokeDeviceSchema = z.object({
  deviceId: z.string().min(1)
});

export const registerDeviceRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const device = new DeviceService();
  const control = new DeviceControlService();
  const guard = requireAuth(auth);
  const deviceGuard = requireDeviceAuth(control);

  app.get('/device/status', { preHandler: guard }, async (request, reply) => {
    return reply.send(await device.status(request.auth!.user.id));
  });

  app.post('/device/link', { preHandler: guard }, async (request, reply) => {
    const parsed = linkSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await device.link(request.auth!.user.id, parsed.data));
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.post('/device/unlink', { preHandler: guard }, async (request, reply) => {
    try {
      return reply.send({ ok: await device.unlink(request.auth!.user.id) });
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.post('/devices/claim/start', { preHandler: guard }, async (request, reply) => {
    return reply.send(await control.startClaim(request.auth!.user.id));
  });

  app.get('/devices/claimed', { preHandler: guard }, async (request, reply) => {
    return reply.send({ items: await control.listDevicesForUser(request.auth!.user.id) });
  });

  app.post('/devices/claim/complete', async (request, reply) => {
    const parsed = claimCompleteSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    try {
      return reply.send(await control.completeClaim(parsed.data));
    } catch (error) {
      const message = (error as Error).message;
      const status = message.includes('already claimed') ? 409 : 400;
      return reply.status(status).send({ error: message });
    }
  });

  app.post('/devices/token', { preHandler: deviceGuard }, async (request, reply) => {
    const parsed = deviceTokenSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    try {
      return reply.send(
        await control.mintLiveKitToken({
          device: request.deviceAuth!.device,
          ...parsed.data
        })
      );
    } catch (error) {
      return reply.status(500).send({ error: (error as Error).message });
    }
  });

  app.post('/devices/heartbeat', { preHandler: deviceGuard }, async (request, reply) => {
    const parsed = deviceHeartbeatSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    return reply.send(
      await control.heartbeat({
        device: request.deviceAuth!.device,
        sessionId: parsed.data.sessionId,
        firmwareVersion: parsed.data.firmwareVersion,
        payload: {
          wifiRssiDbm: parsed.data.wifiRssiDbm,
          batteryPct: parsed.data.batteryPct,
          networkType: parsed.data.networkType,
          ipAddress: parsed.data.ipAddress,
          ...(parsed.data.metadata ?? {})
        }
      })
    );
  });

  app.post('/devices/telemetry', { preHandler: deviceGuard }, async (request, reply) => {
    const parsed = deviceTelemetrySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    return reply.send(
      await control.appendTelemetry({
        device: request.deviceAuth!.device,
        sessionId: parsed.data.sessionId,
        eventType: parsed.data.eventType,
        level: parsed.data.level,
        payload: parsed.data.payload
      })
    );
  });

  app.post('/devices/session/end', { preHandler: deviceGuard }, async (request, reply) => {
    const parsed = deviceSessionEndSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    return reply.send(
      await control.endSession({
        device: request.deviceAuth!.device,
        sessionId: parsed.data.sessionId,
        reason: parsed.data.reason
      })
    );
  });

  app.post('/devices/revoke', { preHandler: guard }, async (request, reply) => {
    const parsed = revokeDeviceSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const ok = await control.revokeDeviceForUser(request.auth!.user.id, parsed.data.deviceId);
    if (!ok) {
      return reply.status(404).send({ error: 'Device not found or already revoked' });
    }
    return reply.send({ ok: true });
  });
};
