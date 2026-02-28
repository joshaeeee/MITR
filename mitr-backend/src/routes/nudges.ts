import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { NudgesService } from '../services/nudges/nudges-service.js';
import { VoiceNotesService } from '../services/nudges/voice-notes-service.js';
import { logger } from '../lib/logger.js';

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'URL must start with http:// or https://');

const nudgeSendSchema = z.object({
  text: z.string().optional(),
  voiceUrl: httpUrlSchema.optional(),
  priority: z.enum(['gentle', 'important', 'urgent']).optional()
});

const nudgeScheduleSchema = z.object({
  text: z.string().optional(),
  voiceUrl: httpUrlSchema.optional(),
  priority: z.enum(['gentle', 'important', 'urgent']).optional(),
  scheduledFor: z.string().min(1)
});

const voiceUploadSchema = z.object({
  mimeType: z.string().default('audio/aac')
});

const voiceSendSchema = z.object({
  fileUrl: httpUrlSchema,
  priority: z.enum(['gentle', 'important', 'urgent']).optional()
});

const voiceUploadParamSchema = z.object({
  voiceNoteId: z.string().uuid()
});

const voiceUploadQuerySchema = z.object({
  token: z.string().min(10)
});

const voiceFileParamSchema = z.object({
  fileName: z.string().min(5)
});

export const registerNudgesRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const nudges = new NudgesService();
  const voiceNotes = new VoiceNotesService();
  const guard = requireAuth(auth);

  app.addContentTypeParser(/^audio\/.*/i, { parseAs: 'buffer' }, (_request, payload, done) => {
    done(null, payload as Buffer);
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, payload, done) => {
    done(null, payload as Buffer);
  });

  app.post('/nudges/send', { preHandler: guard }, async (request, reply) => {
    const parsed = nudgeSendSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    if (!parsed.data.text && !parsed.data.voiceUrl) {
      return reply.status(400).send({ error: 'Either text or voiceUrl is required' });
    }
    return reply.send(await nudges.sendNow(request.auth!.user.id, parsed.data));
  });

  app.post('/nudges/schedule', { preHandler: guard }, async (request, reply) => {
    const parsed = nudgeScheduleSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    if (!parsed.data.text && !parsed.data.voiceUrl) {
      return reply.status(400).send({ error: 'Either text or voiceUrl is required' });
    }
    try {
      return reply.send(await nudges.schedule(request.auth!.user.id, parsed.data));
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.get('/nudges/history', { preHandler: guard }, async (request, reply) => {
    return reply.send({ items: await nudges.history(request.auth!.user.id) });
  });

  app.post('/voice-notes/upload-url', { preHandler: guard }, async (request, reply) => {
    const parsed = voiceUploadSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const protocol = request.headers['x-forwarded-proto'] ?? request.protocol;
    const host = request.headers['x-forwarded-host'] ?? request.headers.host;
    const publicBaseUrl = host ? `${String(protocol)}://${String(host)}` : undefined;
    try {
      return reply.send(
        await voiceNotes.createUploadUrl(request.auth!.user.id, parsed.data.mimeType, publicBaseUrl)
      );
    } catch (error) {
      return reply.status(500).send({ error: (error as Error).message });
    }
  });

  app.put('/voice-notes/upload/:voiceNoteId', { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const parsedParams = voiceUploadParamSchema.safeParse(request.params);
    if (!parsedParams.success) return reply.status(400).send({ error: parsedParams.error.flatten() });
    const parsedQuery = voiceUploadQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) return reply.status(400).send({ error: parsedQuery.error.flatten() });
    if (!Buffer.isBuffer(request.body)) {
      return reply.status(400).send({ error: 'Expected binary audio payload.' });
    }
    try {
      const result = await voiceNotes.handleUpload(
        parsedParams.data.voiceNoteId,
        parsedQuery.data.token,
        request.body
      );
      return reply.send(result);
    } catch (error) {
      logger.warn('Voice note upload failed', {
        voiceNoteId: parsedParams.data.voiceNoteId,
        message: (error as Error).message
      });
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.get('/voice-notes/files/:fileName', async (request, reply) => {
    const parsedParams = voiceFileParamSchema.safeParse(request.params);
    if (!parsedParams.success) return reply.status(400).send({ error: parsedParams.error.flatten() });
    try {
      const file = await voiceNotes.resolveFileForStreaming(parsedParams.data.fileName);
      reply.header('content-type', file.contentType);
      reply.header('content-length', String(file.contentLength));
      reply.header('cache-control', 'public, max-age=86400');
      return reply.send(file.stream);
    } catch (error) {
      return reply.status(404).send({ error: 'Voice note not found.' });
    }
  });

  app.post('/voice-notes/send', { preHandler: guard }, async (request, reply) => {
    const parsed = voiceSendSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return reply.send(await voiceNotes.sendVoiceNote(request.auth!.user.id, parsed.data));
  });
};
