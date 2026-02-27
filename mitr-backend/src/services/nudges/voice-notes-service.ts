import { randomUUID } from 'node:crypto';
import { NudgesService } from './nudges-service.js';

export class VoiceNotesService {
  private readonly nudges = new NudgesService();

  async createUploadUrl(userId: string, mimeType: string): Promise<{
    voiceNoteId: string;
    uploadUrl: string;
    fileUrl: string;
    expiresAt: number;
  }> {
    const voiceNoteId = randomUUID();
    const token = randomUUID();
    const extension = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp4') ? 'm4a' : 'aac';
    const fileUrl = `https://cdn.mitr.local/voice-notes/${voiceNoteId}.${extension}`;
    return {
      voiceNoteId,
      uploadUrl: `https://uploads.mitr.local/presigned/${token}`,
      fileUrl,
      expiresAt: Date.now() + 15 * 60 * 1000
    };
  }

  async sendVoiceNote(userId: string, input: { fileUrl: string; priority?: 'gentle' | 'important' | 'urgent' }) {
    return this.nudges.sendNow(userId, {
      voiceUrl: input.fileUrl,
      priority: input.priority
    });
  }
}
