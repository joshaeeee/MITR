import { getFamilyRepository } from '../family/family-repository.js';

export class CareService {
  private readonly repo = getFamilyRepository();

  private async requireOwner(userId: string): Promise<void> {
    const isOwner = await this.repo.isOwner(userId);
    if (!isOwner) {
      throw new Error('Owner role required');
    }
  }

  async listReminders(userId: string) {
    return this.repo.getCareReminders(userId);
  }

  async createReminder(
    userId: string,
    input: { title: string; description?: string; scheduledTime: string; enabled?: boolean }
  ) {
    await this.requireOwner(userId);
    return this.repo.createCareReminder(userId, input);
  }

  async patchReminder(
    userId: string,
    reminderId: string,
    patch: { title?: string; description?: string; scheduledTime?: string; enabled?: boolean }
  ) {
    await this.requireOwner(userId);
    return this.repo.patchCareReminder(userId, reminderId, patch);
  }

  async deleteReminder(userId: string, reminderId: string) {
    await this.requireOwner(userId);
    return this.repo.deleteCareReminder(userId, reminderId);
  }

  async listRoutines(userId: string) {
    return this.repo.getOrCreateRoutines(userId);
  }

  async patchRoutine(
    userId: string,
    routineId: string,
    patch: { title?: string; enabled?: boolean; schedule?: string }
  ) {
    await this.requireOwner(userId);
    return this.repo.patchRoutine(userId, routineId, patch);
  }
}
