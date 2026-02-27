import { randomUUID } from 'node:crypto';
import { getFamilyRepository } from './family-repository.js';
import type { FamilyMember, FamilyRole } from './family-types.js';

export class FamilyService {
  private readonly repo = getFamilyRepository();

  private async requireOwner(userId: string): Promise<void> {
    const isOwner = await this.repo.isOwner(userId);
    if (!isOwner) {
      throw new Error('Owner role required');
    }
  }

  async getFamilyMe(userId: string): Promise<{
    familyId: string;
    ownerUserId: string;
    member: FamilyMember | null;
  }> {
    const family = (await this.repo.getFamilyByUser(userId)) ?? (await this.repo.getOrCreateFamilyForOwner(userId));
    const members = await this.repo.getMembersByFamilyId(family.id);
    const member = await this.repo.getMemberByUser(userId);
    return {
      familyId: family.id,
      ownerUserId: family.ownerUserId,
      member
    };
  }

  async listMembers(userId: string): Promise<FamilyMember[]> {
    const family = (await this.repo.getFamilyByUser(userId)) ?? (await this.repo.getOrCreateFamilyForOwner(userId));
    return this.repo.getMembersByFamilyId(family.id);
  }

  async inviteMember(
    userId: string,
    input: { displayName?: string; email?: string; phone?: string; role?: FamilyRole }
  ): Promise<FamilyMember> {
    await this.requireOwner(userId);
    return this.repo.addMember(userId, {
      userId: randomUUID(),
      displayName: input.displayName,
      email: input.email,
      phone: input.phone,
      role: input.role ?? 'member'
    });
  }

  async updateMemberRole(userId: string, memberId: string, role: FamilyRole): Promise<FamilyMember | null> {
    await this.requireOwner(userId);
    return this.repo.setMemberRole(memberId, role);
  }

  async removeMember(userId: string, memberId: string): Promise<boolean> {
    await this.requireOwner(userId);
    return this.repo.removeMember(memberId);
  }
}
