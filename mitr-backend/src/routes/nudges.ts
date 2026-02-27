import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { NudgesService } from '../services/nudges/nudges-service.js';
import { VoiceNotesService } from '../services/nudges/voice-notes-service.js';

const nudgeSendSchema = z.object({
  text: z.string().optional(),
  voiceUrl: z.string().url().optional(),
  priority: z.enum(['gentle', 'important', 'urgent']).optional()
});

const nudgeScheduleSchema = z.object({
  text: z.string().optional(),
  voiceUrl: z.string().url().optional(),
  priority: z.enum(['gentle', 'important', 'urgent']).optional(),
  scheduledFor: z.string().min(1)
});

const voiceUploadSchema = z.object({
  mimeType: z.string().default('audio/aac')
});

const voiceSendSchema = z.object({
  fileUrl: z.string().url(),
  priority: z.enum(['gentle', 'important', 'urgent']).optional()
});

export const registerNudgesRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const nudges = new NudgesService();
  const voiceNotes = new VoiceNotesService();
  const guard = requireAuth(auth);

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
    return reply.send(await voiceNotes.createUploadUrl(request.auth!.user.id, parsed.data.mimeType));
  });

  app.post('/voice-notes/send', { preHandler: guard }, async (request, reply) => {
    const parsed = voiceSendSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    return reply.send(await voiceNotes.sendVoiceNote(request.auth!.user.id, parsed.data));
  });
};
