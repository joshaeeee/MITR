import { getFamilyRepository } from '../family/family-repository.js';

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
    await this.repo.getOrCreateFamilyForOwner(userId);
    return this.repo.updateAlertStatus(alertId, 'acknowledged');
  }

  async resolve(userId: string, alertId: string) {
    await this.repo.getOrCreateFamilyForOwner(userId);
    return this.repo.updateAlertStatus(alertId, 'resolved');
  }
}
