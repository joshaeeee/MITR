import { getFamilyRepository } from '../family/family-repository.js';

export class ElderService {
  private readonly repo = getFamilyRepository();

  private async requireOwner(userId: string): Promise<void> {
    const isOwner = await this.repo.isOwner(userId);
    if (!isOwner) {
      throw new Error('Owner role required');
    }
  }

  async getProfile(userId: string) {
    return this.repo.getElderByUser(userId);
  }

  async upsertProfile(
    userId: string,
    input: { name: string; ageRange?: string; language?: string; city?: string; timezone?: string }
  ) {
    await this.requireOwner(userId);
    return this.repo.upsertElder(userId, input);
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
