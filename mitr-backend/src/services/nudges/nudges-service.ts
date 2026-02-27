import { getFamilyRepository } from '../family/family-repository.js';
import type { NudgePriority } from '../family/family-types.js';
import { SessionStore } from '../session-store.js';

export class NudgesService {
  private readonly repo = getFamilyRepository();
  private readonly store = new SessionStore();

  async sendNow(
    userId: string,
    input: { text?: string; voiceUrl?: string; priority?: NudgePriority }
  ) {
    const created = await this.repo.addNudge(userId, {
      type: input.voiceUrl ? 'voice' : 'text',
      text: input.text,
      voiceUrl: input.voiceUrl,
      priority: input.priority ?? 'gentle',
      scheduledFor: Date.now()
    });

    await this.store.pushUserEvent(userId, {
      type: 'family_nudge_delivered',
      payload: {
        nudgeId: created.id,
        type: created.type,
        text: created.text,
        voiceUrl: created.voiceUrl,
        priority: created.priority
      }
    });
    return created;
  }

  async schedule(
    userId: string,
    input: { text?: string; voiceUrl?: string; priority?: NudgePriority; scheduledFor: string }
  ) {
    const scheduledAt = Date.parse(input.scheduledFor);
    if (Number.isNaN(scheduledAt)) throw new Error('Invalid scheduledFor datetime');
    return this.repo.addNudge(userId, {
      type: input.voiceUrl ? 'voice' : 'text',
      text: input.text,
      voiceUrl: input.voiceUrl,
      priority: input.priority ?? 'gentle',
      scheduledFor: scheduledAt
    });
  }

  async history(userId: string) {
    return this.repo.getNudges(userId);
  }
}
