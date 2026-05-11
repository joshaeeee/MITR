import { getFamilyRepository } from '../family/family-repository.js';
import { ElderJourneyService, type JourneyProfilePatch } from '../elder-journey/elder-journey-service.js';

export class ElderService {
  private readonly repo = getFamilyRepository();
  private readonly journey = new ElderJourneyService();

  private async requireOwner(userId: string): Promise<void> {
    await this.repo.getOrCreateFamilyForOwner(userId);
    const isOwner = await this.repo.isOwner(userId);
    if (!isOwner) {
      throw new Error('Owner role required');
    }
  }

  async getProfile(userId: string) {
    return this.repo.getElderByUser(userId);
  }

  async getJourneyProfile(userId: string) {
    return this.journey.getJourneyProfile(userId);
  }

  async upsertProfile(
    userId: string,
    input: { name: string; ageRange?: string; language?: string; city?: string; timezone?: string }
  ) {
    await this.requireOwner(userId);
    return this.repo.upsertElder(userId, input);
  }

  async upsertJourneyProfile(userId: string, input: JourneyProfilePatch) {
    await this.requireOwner(userId);
    return this.journey.upsertJourneyProfile(userId, input);
  }

  async getDeviceStatus(userId: string) {
    return this.repo.getDeviceStatus(userId);
  }

  async linkDevice(userId: string, input: { serialNumber: string; firmwareVersion?: string }) {
    await this.requireOwner(userId);
    return this.repo.linkDevice(userId, input);
  }

  async unlinkDevice(userId: string) {
    await this.requireOwner(userId);
    return this.repo.unlinkDevice(userId);
  }
}
