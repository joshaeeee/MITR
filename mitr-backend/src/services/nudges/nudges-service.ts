import { getFamilyRepository } from '../family/family-repository.js';
import type { NudgePriority } from '../family/family-types.js';
import { SessionStore } from '../session-store.js';

export class NudgesService {
  private readonly repo = getFamilyRepository();
  private readonly store = new SessionStore();

  private toPreviewText(nudge: {
    type: 'text' | 'voice';
    text?: string;
    voiceUrl?: string;
  }): string {
    if (nudge.type === 'text') return nudge.text ?? 'You have a family message.';
    if (nudge.voiceUrl && /^https?:\/\//i.test(nudge.voiceUrl)) {
      return 'You have a voice message from family.';
    }
    return 'You have a voice message from family, but playback link is not available.';
  }

  private async toAgentNudgePayload(nudge: {
    id: string;
    type: 'text' | 'voice';
    text?: string;
    voiceUrl?: string;
    priority: NudgePriority;
    createdByUserId: string;
    createdAt: number;
    scheduledFor: number;
  }) {
    const sender = await this.repo.getMemberByUser(nudge.createdByUserId);
    return {
      nudgeId: nudge.id,
      type: nudge.type,
      text: nudge.text,
      voiceUrl: nudge.voiceUrl,
      priority: nudge.priority,
      fromUserId: nudge.createdByUserId,
      fromName: sender?.displayName ?? sender?.email ?? sender?.phone ?? 'family member',
      previewText: this.toPreviewText(nudge),
      createdAt: nudge.createdAt,
      scheduledFor: nudge.scheduledFor
    };
  }

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
      type: 'family_nudge_queued',
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

  async getPendingForElder(userId: string) {
    const pendingRows = await this.repo.getPendingNudges(userId);
    if (pendingRows.length === 0) return null;

    const normalized: Array<{
      nudgeId: string;
      type: 'text' | 'voice';
      text?: string;
      voiceUrl?: string;
      priority: NudgePriority;
      fromUserId: string;
      fromName: string;
      previewText: string;
      createdAt: number;
      scheduledFor: number;
    }> = [];

    for (const row of pendingRows) {
      let pending = row;
      if (pending.deliveryState === 'queued' || pending.deliveryState === 'delivering') {
        const delivered = await this.repo.markNudgeDelivered(userId, pending.id);
        if (delivered) {
          pending = delivered;
          await this.store.pushUserEvent(userId, {
            type: 'family_nudge_delivered',
            payload: {
              nudgeId: delivered.id,
              type: delivered.type,
              text: delivered.text,
              voiceUrl: delivered.voiceUrl,
              priority: delivered.priority
            }
          });
        }
      }

      normalized.push({
        nudgeId: pending.id,
        type: pending.type,
        text: pending.text,
        voiceUrl: pending.voiceUrl,
        priority: pending.priority,
        fromUserId: pending.createdByUserId,
        fromName: 'family member',
        previewText: this.toPreviewText(pending),
        createdAt: pending.createdAt,
        scheduledFor: pending.scheduledFor
      });
    }

    return {
      pendingCount: normalized.length,
      nudges: normalized
    };
  }

  async markListened(userId: string, nudgeIds: string[]) {
    const dedupedIds = [...new Set(nudgeIds)].filter((id) => id.trim().length > 0);
    const acknowledged: Array<{
      nudgeId: string;
      type: 'text' | 'voice';
      text?: string;
      voiceUrl?: string;
      priority: NudgePriority;
      fromUserId: string;
      fromName: string;
      previewText: string;
      createdAt: number;
      scheduledFor: number;
    }> = [];

    for (const nudgeId of dedupedIds) {
      const updated = await this.repo.acknowledgeNudge(userId, nudgeId);
      if (!updated) continue;
      const payload = await this.toAgentNudgePayload(updated);
      await this.store.pushUserEvent(userId, {
        type: 'family_nudge_acknowledged',
        payload: {
          ...payload
        }
      });
      acknowledged.push(payload);
    }

    return acknowledged;
  }
}
