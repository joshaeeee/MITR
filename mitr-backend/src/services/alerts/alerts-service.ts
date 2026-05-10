import { getFamilyRepository } from '../family/family-repository.js';
import { recordAuditEvent } from '../audit/audit-service.js';

export class AlertsService {
  private readonly repo = getFamilyRepository();

  async list(userId: string) {
    let alerts = await this.repo.getAlerts(userId);
    if (alerts.length === 0) {
      await this.repo.createAlert(userId, {
        severity: 'medium',
        title: 'Low engagement detected',
        details: 'Elder engagement dropped compared to weekly baseline.'
      });
      alerts = await this.repo.getAlerts(userId);
    }
    return alerts;
  }

  async getById(userId: string, alertId: string) {
    const alerts = await this.repo.getAlerts(userId);
    return alerts.find((a) => a.id === alertId) ?? null;
  }

  async acknowledge(userId: string, alertId: string) {
    const alert = await this.repo.updateAlertStatus(userId, alertId, 'acknowledged');
    if (alert) {
      await recordAuditEvent({
        actorUserId: userId,
        scope: `elder:${alert.elderId}`,
        action: 'alert.acknowledged',
        payload: { alertId }
      });
    }
    return alert;
  }

  async resolve(userId: string, alertId: string) {
    const alert = await this.repo.updateAlertStatus(userId, alertId, 'resolved');
    if (alert) {
      await recordAuditEvent({
        actorUserId: userId,
        scope: `elder:${alert.elderId}`,
        action: 'alert.resolved',
        payload: { alertId }
      });
    }
    return alert;
  }
}
