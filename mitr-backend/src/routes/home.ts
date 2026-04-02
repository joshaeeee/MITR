import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { AlertsService } from '../services/alerts/alerts-service.js';
import { CareService } from '../services/care/care-service.js';
import { DeviceService } from '../services/device/device-service.js';
import { ElderService } from '../services/elder/elder-service.js';
import { RealtimeHomeService } from '../services/insights/realtime-home-service.js';
import { NudgesService } from '../services/nudges/nudges-service.js';

const iconForTimeline = (type: 'nudge' | 'reminder'): string => (type === 'nudge' ? 'Send' : 'Pill');
const colorForTimeline = (type: 'nudge' | 'reminder'): string => (type === 'nudge' ? 'sky' : 'lavender');

export const registerHomeRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const guard = requireAuth(auth);
  const elder = new ElderService();
  const devices = new DeviceService();
  const alerts = new AlertsService();
  const care = new CareService();
  const nudges = new NudgesService();
  const insights = new RealtimeHomeService();

  app.get('/home/summary', { preHandler: guard }, async (request, reply) => {
    const userId = request.auth!.user.id;

    const [profile, deviceStatus, productionStatus, alertItems, nudgeItems, reminderItems, realtimeDigest] = await Promise.all([
      elder.getProfile(userId),
      elder.getDeviceStatus(userId),
      devices.status(userId, { includeLegacy: false }),
      alerts.list(userId),
      nudges.history(userId),
      care.listReminders(userId),
      insights.getRealtimeForHome(userId)
    ]);

    const nudgeEvents = nudgeItems.slice(0, 3).map((n) => ({
      id: n.id,
      type: 'nudge' as const,
      title: n.type === 'voice' ? 'Voice nudge sent' : 'Nudge sent',
      subtitle: n.type === 'voice' ? 'Voice note from family' : (n.text ?? ''),
      timestampMs: n.createdAt,
      icon: iconForTimeline('nudge'),
      color: colorForTimeline('nudge')
    }));

    const reminderEvents = reminderItems.slice(0, 2).map((r) => ({
      id: r.id,
      type: 'reminder' as const,
      title: r.title,
      subtitle: 'Scheduled reminder',
      scheduledTime: r.scheduledTime,
      icon: iconForTimeline('reminder'),
      color: colorForTimeline('reminder')
    }));

    return reply.send({
      user: request.auth!.user,
      profile,
      deviceStatus,
      productionDevice: productionStatus.productionDevice,
      deviceUsageSummary: deviceStatus.snapshot.deviceUsageSummary,
      alerts: alertItems,
      timeline: [...nudgeEvents, ...reminderEvents],
      insights: {
        scoreBand: realtimeDigest?.scoreBand ?? 'watch',
        confidence: Number(realtimeDigest?.confidence ?? 0),
        dataSufficiency: Number(realtimeDigest?.dataSufficiency ?? 0),
        insufficientConfidence: Boolean(realtimeDigest?.insufficientConfidence ?? true),
        hasConversationData: Boolean(realtimeDigest?.hasConversationData ?? false),
        insightsPending: Boolean(realtimeDigest?.insightsPending ?? false),
        insightState: realtimeDigest?.insightState ?? 'no_conversations',
        topConcern: realtimeDigest?.topConcern ?? null,
        recommendedAction: realtimeDigest?.recommendedAction ?? null,
        lastComputedAt: realtimeDigest?.lastComputedAt ?? null
      }
    });
  });
};
