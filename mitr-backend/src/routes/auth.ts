import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from '../services/auth/auth-service.js';
import { requireAuth } from '../services/auth/auth-middleware.js';
import { logger } from '../lib/logger.js';

const otpStartSchema = z.object({
  phone: z.string().min(6)
});

const otpVerifySchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().min(4),
  name: z.string().optional()
});

const emailSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().optional()
});

const emailLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const oauthSchema = z.object({
  token: z.string().optional(),
  email: z.string().email().optional(),
  name: z.string().optional(),
  providerUserId: z.string().optional()
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const swiggyCallbackSchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional()
});

export const registerAuthRoutes = (app: FastifyInstance, auth: AuthService): void => {
  app.post('/auth/otp/start', async (request, reply) => {
    const parsed = otpStartSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const result = await auth.startOtp(parsed.data.phone);
    return reply.send(result);
  });

  app.post('/auth/otp/verify', async (request, reply) => {
    const parsed = otpVerifySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const result = await auth.verifyOtp(parsed.data);
      return reply.send(result);
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.post('/auth/email/signup', async (request, reply) => {
    const parsed = emailSignupSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const result = await auth.signupEmail(parsed.data);
      return reply.send(result);
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.post('/auth/email/login', async (request, reply) => {
    const parsed = emailLoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const result = await auth.loginEmail(parsed.data);
      return reply.send(result);
    } catch (error) {
      return reply.status(401).send({ error: (error as Error).message });
    }
  });

  app.post('/auth/oauth/apple', async (request, reply) => {
    const parsed = oauthSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const result = await auth.oauthLogin({
      provider: 'apple',
      email: parsed.data.email,
      name: parsed.data.name,
      providerUserId: parsed.data.providerUserId
    });
    return reply.send(result);
  });

  app.post('/auth/oauth/google', async (request, reply) => {
    const parsed = oauthSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const result = await auth.oauthLogin({
      provider: 'google',
      email: parsed.data.email,
      name: parsed.data.name,
      providerUserId: parsed.data.providerUserId
    });
    return reply.send(result);
  });

  app.post('/auth/session/refresh', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const result = await auth.refresh(parsed.data);
      return reply.send(result);
    } catch (error) {
      return reply.status(401).send({ error: (error as Error).message });
    }
  });

  app.post('/auth/logout', { preHandler: requireAuth(auth) }, async (request, reply) => {
    await auth.logout(request.auth!.accessToken);
    return reply.send({ ok: true });
  });

  app.get('/auth/me', { preHandler: requireAuth(auth) }, async (request, reply) => {
    return reply.send({ user: request.auth!.user });
  });

  app.get('/auth/swiggy/callback', async (request, reply) => {
    const parsed = swiggyCallbackSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const { code, state, error, error_description: errorDescription } = parsed.data;
    logger.info('Swiggy OAuth callback received', {
      hasCode: Boolean(code),
      hasState: Boolean(state),
      error: error ?? null,
      errorDescription: errorDescription ?? null
    });
    if (error) {
      return reply
        .status(400)
        .type('text/html; charset=utf-8')
        .send(`<!doctype html><html><body><h1>Swiggy authorization failed</h1><p>${error}</p></body></html>`);
    }
    return reply
      .status(200)
      .type('text/html; charset=utf-8')
      .send('<!doctype html><html><body><h1>Mitr &times; Swiggy</h1><p>Authorization received. You can close this window.</p></body></html>');
  });
};
