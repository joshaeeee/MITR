import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { AlertsService } from '../services/alerts/alerts-service.js';
import { CareService } from '../services/care/care-service.js';
import { ElderService } from '../services/elder/elder-service.js';
import { InsightsService } from '../services/insights/insights-service.js';
import { NudgesService } from '../services/nudges/nudges-service.js';

const iconForTimeline = (type: 'nudge' | 'reminder'): string => (type === 'nudge' ? 'Send' : 'Pill');
const colorForTimeline = (type: 'nudge' | 'reminder'): string => (type === 'nudge' ? 'sky' : 'lavender');

export const registerHomeRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const guard = requireAuth(auth);
  const elder = new ElderService();
  const alerts = new AlertsService();
  const care = new CareService();
  const nudges = new NudgesService();
  const insights = new InsightsService();

  app.get('/home/summary', { preHandler: guard }, async (request, reply) => {
    const userId = request.auth!.user.id;

    const [profile, deviceStatus, alertItems, nudgeItems, reminderItems, insightOverview] = await Promise.all([
      elder.getProfile(userId),
      elder.getDeviceStatus(userId),
      alerts.list(userId),
      nudges.history(userId),
      care.listReminders(userId),
      insights.overview(userId)
    ]);

    const nudgeEvents = nudgeItems.slice(0, 3).map((n) => ({
      id: n.id,
      type: 'nudge' as const,
      title: n.type === 'voice' ? 'Voice nudge sent' : 'Nudge sent',
      subtitle: n.text ?? n.voiceUrl ?? '',
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
      alerts: alertItems,
      timeline: [...nudgeEvents, ...reminderEvents],
      insights: {
        scoreBand: (insightOverview as Record<string, unknown>).scoreBand ?? 'watch',
        confidence: Number((insightOverview as Record<string, unknown>).confidence ?? 0),
        dataSufficiency: Number((insightOverview as Record<string, unknown>).dataSufficiency ?? 0),
        lastComputedAt: (insightOverview as Record<string, unknown>).lastComputedAt ?? null
      }
    });
  });
};
