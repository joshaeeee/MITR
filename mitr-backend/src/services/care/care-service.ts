import { getFamilyRepository } from '../family/family-repository.js';
import type { CarePlanSection, CarePlanType } from '../family/family-types.js';

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

  async listItems(userId: string) {
    return this.repo.getCarePlanItems(userId);
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

  async createItem(
    userId: string,
    input: {
      section: CarePlanSection;
      type?: CarePlanType;
      title: string;
      description?: string;
      enabled?: boolean;
      scheduledAt?: string;
      repeatRule?: string;
      metadata?: Record<string, unknown>;
      sortOrder?: number;
    }
  ) {
    await this.requireOwner(userId);
    return this.repo.createCarePlanItem(userId, input);
  }

  async patchItem(
    userId: string,
    itemId: string,
    patch: {
      section?: CarePlanSection;
      type?: CarePlanType;
      title?: string;
      description?: string;
      enabled?: boolean;
      scheduledAt?: string;
      repeatRule?: string;
      metadata?: Record<string, unknown>;
      sortOrder?: number;
    }
  ) {
    await this.requireOwner(userId);
    return this.repo.patchCarePlanItem(userId, itemId, patch);
  }

  async deleteItem(userId: string, itemId: string) {
    await this.requireOwner(userId);
    return this.repo.deleteCarePlanItem(userId, itemId);
  }
}
