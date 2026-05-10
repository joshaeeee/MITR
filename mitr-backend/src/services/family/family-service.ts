import { recordAuditEvent } from '../audit/audit-service.js';
import type { AuthUser } from '../auth/auth-service.js';
import { getFamilyRepository } from './family-repository.js';
import type { FamilyMember, FamilyRole } from './family-types.js';

const normalizeEmail = (value?: string): string | undefined => value?.trim().toLowerCase() || undefined;
const normalizePhone = (value?: string): string | undefined => value?.trim() || undefined;

export class FamilyService {
  private readonly repo = getFamilyRepository();

  private async requireOwnerFamily(userId: string): Promise<string> {
    const family = await this.repo.getFamilyByUser(userId);
    const member = await this.repo.getMemberByUser(userId);
    if (!family || !member || member.familyId !== family.id || member.role !== 'owner') {
      throw new Error('Owner role required');
    }
    return family.id;
  }

  private async getOrCreateFamilyForUser(user: AuthUser) {
    let family = await this.repo.getFamilyByUser(user.id);
    if (family) return family;

    const accepted = await this.acceptPendingInvite(user);
    if (accepted) {
      family = await this.repo.getFamilyByUser(user.id);
      if (family) return family;
    }

    return this.repo.getOrCreateFamilyForOwner(user.id);
  }

  async getFamilyMe(user: AuthUser): Promise<{
    familyId: string;
    ownerUserId: string;
    member: FamilyMember | null;
  }> {
    const family = await this.getOrCreateFamilyForUser(user);
    const member = await this.repo.getMemberByUser(user.id);
    return {
      familyId: family.id,
      ownerUserId: family.ownerUserId,
      member
    };
  }

  async listMembers(user: AuthUser): Promise<FamilyMember[]> {
    const family = await this.getOrCreateFamilyForUser(user);
    return this.repo.getMembersByFamilyId(family.id);
  }

  async inviteMember(
    userId: string,
    input: { displayName?: string; email?: string; phone?: string; role?: FamilyRole }
  ): Promise<FamilyMember> {
    if (input.role === 'owner') {
      throw new Error('Invitees must accept and sign in before owner promotion');
    }
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    if (!email && !phone) {
      throw new Error('Invite requires an email or phone');
    }

    const familyId = await this.requireOwnerFamily(userId);
    const member = await this.repo.addMember(userId, {
      displayName: input.displayName,
      email,
      phone,
      role: 'member'
    });
    await recordAuditEvent({
      actorUserId: userId,
      scope: `family:${familyId}`,
      action: 'family.member_invited',
      payload: { memberId: member.id, role: member.role }
    });
    return member;
  }

  async acceptPendingInvite(user: AuthUser): Promise<FamilyMember | null> {
    const existing = await this.repo.getMemberByUser(user.id);
    if (existing?.acceptedAt) return existing;

    const member = await this.repo.acceptPendingInviteForUser({
      id: user.id,
      email: user.email,
      phone: user.phone
    });
    if (member) {
      await recordAuditEvent({
        actorUserId: user.id,
        scope: `family:${member.familyId}`,
        action: 'family.member_invite_accepted',
        payload: { memberId: member.id }
      });
    }
    return member;
  }

  async updateMemberRole(userId: string, memberId: string, role: FamilyRole): Promise<FamilyMember | null> {
    const familyId = await this.requireOwnerFamily(userId);
    const member = await this.repo.setMemberRole(familyId, memberId, role);
    if (member) {
      await recordAuditEvent({
        actorUserId: userId,
        scope: `family:${familyId}`,
        action: 'family.member_role_updated',
        payload: { memberId, role }
      });
    }
    return member;
  }

  async removeMember(userId: string, memberId: string): Promise<boolean> {
    const familyId = await this.requireOwnerFamily(userId);
    const removed = await this.repo.removeMember(familyId, memberId);
    if (removed) {
      await recordAuditEvent({
        actorUserId: userId,
        scope: `family:${familyId}`,
        action: 'family.member_removed',
        payload: { memberId }
      });
    }
    return removed;
  }
}
