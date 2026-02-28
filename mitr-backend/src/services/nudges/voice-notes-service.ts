import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { getSharedRedisClient } from '../../lib/redis.js';
import { NudgesService } from './nudges-service.js';

type VoicePriority = 'gentle' | 'important' | 'urgent';

interface PendingUpload {
  voiceNoteId: string;
  token: string;
  fileName: string;
  fileUrl: string;
  mimeType: string;
  expiresAt: number;
  userId: string;
}

const UPLOAD_TTL_MS = 15 * 60 * 1000;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const DEFAULT_MIME_TYPE = 'audio/mp4';
const SAFE_EXTENSIONS = new Set(['m4a', 'aac', 'wav', 'mp3', 'ogg', 'webm', 'flac']);
const pendingUploadKey = (voiceNoteId: string): string => `voice_notes:pending:${voiceNoteId}`;

const resolveExtension = (mimeType: string): string => {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('ogg') || normalized.includes('oga')) return 'ogg';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('flac')) return 'flac';
  if (normalized.includes('aac')) return 'aac';
  return 'm4a';
};

const resolveMimeTypeFromFile = (fileName: string): string => {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  switch (ext) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    default:
      return 'audio/mp4';
  }
};

export class VoiceNotesService {
  private readonly nudges = new NudgesService();
  private readonly redis = getSharedRedisClient();
  private readonly pendingUploads = new Map<string, PendingUpload>();

  private getStorageDir(): string {
    return path.isAbsolute(env.VOICE_NOTES_STORAGE_DIR)
      ? env.VOICE_NOTES_STORAGE_DIR
      : path.resolve(process.cwd(), env.VOICE_NOTES_STORAGE_DIR);
  }

  private resolvePublicBaseUrl(input?: string): string {
    const base = input?.trim() || env.API_PUBLIC_BASE_URL?.trim();
    if (!base) {
      throw new Error('API public base URL is not configured');
    }
    return base.replace(/\/+$/, '');
  }

  private async savePendingUpload(upload: PendingUpload): Promise<void> {
    this.pendingUploads.set(upload.voiceNoteId, upload);
    if (!this.redis) return;
    await this.redis.set(
      pendingUploadKey(upload.voiceNoteId),
      JSON.stringify(upload),
      'EX',
      Math.ceil(UPLOAD_TTL_MS / 1000)
    );
  }

  private async getPendingUpload(voiceNoteId: string): Promise<PendingUpload | null> {
    const fromMemory = this.pendingUploads.get(voiceNoteId);
    if (fromMemory) {
      if (fromMemory.expiresAt >= Date.now()) return fromMemory;
      this.pendingUploads.delete(voiceNoteId);
    }
    if (!this.redis) return null;
    const raw = await this.redis.get(pendingUploadKey(voiceNoteId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PendingUpload;
      if (parsed.expiresAt < Date.now()) return null;
      this.pendingUploads.set(parsed.voiceNoteId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  private async clearPendingUpload(voiceNoteId: string): Promise<void> {
    this.pendingUploads.delete(voiceNoteId);
    if (!this.redis) return;
    await this.redis.del(pendingUploadKey(voiceNoteId));
  }

  async createUploadUrl(
    userId: string,
    mimeType: string,
    publicBaseUrl?: string
  ): Promise<{
    voiceNoteId: string;
    uploadUrl: string;
    fileUrl: string;
    expiresAt: number;
  }> {
    const resolvedBaseUrl = this.resolvePublicBaseUrl(publicBaseUrl);
    const safeMimeType = mimeType?.trim() || DEFAULT_MIME_TYPE;
    const extension = resolveExtension(safeMimeType);
    const voiceNoteId = randomUUID();
    const token = randomUUID().replace(/-/g, '');
    const expiresAt = Date.now() + UPLOAD_TTL_MS;
    const fileName = `${voiceNoteId}.${extension}`;
    const uploadUrl = `${resolvedBaseUrl}/voice-notes/upload/${voiceNoteId}?token=${token}`;
    const fileUrl = `${resolvedBaseUrl}/voice-notes/files/${fileName}`;

    await this.savePendingUpload({
      voiceNoteId,
      token,
      fileName,
      fileUrl,
      mimeType: safeMimeType,
      expiresAt,
      userId
    });

    return {
      voiceNoteId,
      uploadUrl,
      fileUrl,
      expiresAt
    };
  }

  async handleUpload(
    voiceNoteId: string,
    token: string,
    payload: Buffer
  ): Promise<{
    ok: true;
    fileUrl: string;
    bytes: number;
  }> {
    if (!token || token.trim().length < 10) {
      throw new Error('Missing or invalid upload token');
    }
    if (!Buffer.isBuffer(payload) || payload.length === 0) {
      throw new Error('Upload payload is empty');
    }
    if (payload.length > MAX_UPLOAD_BYTES) {
      throw new Error('Voice note exceeds max upload size (12MB)');
    }

    const pending = await this.getPendingUpload(voiceNoteId);
    if (!pending) {
      throw new Error('Upload session expired or not found');
    }
    if (pending.token !== token) {
      throw new Error('Upload token mismatch');
    }
    if (pending.expiresAt < Date.now()) {
      await this.clearPendingUpload(voiceNoteId);
      throw new Error('Upload session expired');
    }

    const storageDir = this.getStorageDir();
    await mkdir(storageDir, { recursive: true });
    const outputPath = path.join(storageDir, pending.fileName);
    await writeFile(outputPath, payload);
    await this.clearPendingUpload(voiceNoteId);

    logger.info('Voice note upload stored', {
      voiceNoteId,
      bytes: payload.length,
      fileName: pending.fileName
    });

    return {
      ok: true,
      fileUrl: pending.fileUrl,
      bytes: payload.length
    };
  }

  async resolveFileForStreaming(fileName: string): Promise<{
    stream: ReturnType<typeof createReadStream>;
    contentType: string;
    contentLength: number;
  }> {
    const safeName = path.basename(fileName);
    const ext = path.extname(safeName).slice(1).toLowerCase();
    if (!SAFE_EXTENSIONS.has(ext)) {
      throw new Error('Unsupported voice note extension');
    }
    if (!/^[a-zA-Z0-9-]+\.[a-z0-9]+$/.test(safeName)) {
      throw new Error('Invalid voice note file name');
    }

    const fullPath = path.join(this.getStorageDir(), safeName);
    const fileStats = await stat(fullPath);
    return {
      stream: createReadStream(fullPath),
      contentType: resolveMimeTypeFromFile(safeName),
      contentLength: fileStats.size
    };
  }

  async sendVoiceNote(
    userId: string,
    input: { fileUrl: string; priority?: VoicePriority }
  ) {
    return this.nudges.sendNow(userId, {
      voiceUrl: input.fileUrl,
      priority: input.priority
    });
  }
}

