import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FamilyService } from '../services/family/family-service.js';
import { requireAuth } from '../services/auth/auth-middleware.js';
import type { AuthService } from '../services/auth/auth-service.js';
import { createRateLimit } from '../lib/rate-limit.js';

const inviteSchema = z.object({
  displayName: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  role: z.enum(['owner', 'member']).optional()
});

const updateRoleSchema = z.object({
  role: z.enum(['owner', 'member'])
});

const memberParamSchema = z.object({
  id: z.string().min(1)
});

export const registerFamilyRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const family = new FamilyService();
  const guard = requireAuth(auth);
  const familyMutationLimit = createRateLimit({
    keyPrefix: 'family:mutation',
    windowMs: 10 * 60 * 1000,
    max: 30,
    key: (request) => request.auth?.user.id ?? request.ip
  });
  const inviteLimit = createRateLimit({
    keyPrefix: 'family:invite',
    windowMs: 60 * 60 * 1000,
    max: 20,
    key: (request) => request.auth?.user.id ?? request.ip
  });
  const acceptInviteLimit = createRateLimit({
    keyPrefix: 'family:invite-accept',
    windowMs: 10 * 60 * 1000,
    max: 10,
    key: (request) => request.auth?.user.id ?? request.ip
  });

  app.get('/family/me', { preHandler: guard }, async (request, reply) => {
    return reply.send(await family.getFamilyMe(request.auth!.user));
  });

  app.get('/family/members', { preHandler: guard }, async (request, reply) => {
    return reply.send({ items: await family.listMembers(request.auth!.user) });
  });

  app.post('/family/invite', { preHandler: [guard, inviteLimit] }, async (request, reply) => {
    const parsed = inviteSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      return reply.send(await family.inviteMember(request.auth!.user.id, parsed.data));
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.post('/family/invite/accept', { preHandler: [guard, acceptInviteLimit] }, async (request, reply) => {
    try {
      const member = await family.acceptPendingInvite(request.auth!.user);
      if (!member) return reply.status(404).send({ error: 'Pending invite not found' });
      return reply.send(member);
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.patch('/family/members/:id/role', { preHandler: [guard, familyMutationLimit] }, async (request, reply) => {
    const params = memberParamSchema.safeParse(request.params);
    const body = updateRoleSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: { params: params.success ? null : params.error.flatten(), body: body.success ? null : body.error.flatten() } });
    }
    try {
      const updated = await family.updateMemberRole(request.auth!.user.id, params.data.id, body.data.role);
      if (!updated) return reply.status(404).send({ error: 'Member not found' });
      return reply.send(updated);
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });

  app.delete('/family/members/:id', { preHandler: [guard, familyMutationLimit] }, async (request, reply) => {
    const params = memberParamSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: params.error.flatten() });
    try {
      const ok = await family.removeMember(request.auth!.user.id, params.data.id);
      if (!ok) return reply.status(404).send({ error: 'Member not found' });
      return reply.send({ ok: true });
    } catch (error) {
      return reply.status(403).send({ error: (error as Error).message });
    }
  });
};
