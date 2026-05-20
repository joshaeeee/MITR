import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService } from '../services/auth/auth-service.js';
import { requireAuth } from '../services/auth/auth-middleware.js';
import { verifyOAuthIdToken } from '../services/auth/oauth-verifier.js';
import { logger } from '../lib/logger.js';
import { createRateLimit, bodyFieldKey } from '../lib/rate-limit.js';
import { SwiggyMcpService } from '../services/commerce/swiggy-mcp-service.js';

const otpStartSchema = z.object({
  phone: z.string().min(6)
});

const otpVerifySchema = z.object({
  challengeId: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
  name: z.string().optional()
});

const emailSignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(128),
  name: z.string().optional()
});

const emailLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

const oauthSchema = z.object({
  token: z.string().min(20).max(8192),
  name: z.string().optional()
});

const refreshSchema = z.object({
  refreshToken: z.string().min(32)
});

const swiggyCallbackSchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional()
});

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const registerAuthRoutes = (app: FastifyInstance, auth: AuthService): void => {
  const swiggy = new SwiggyMcpService();
  const otpStartLimit = createRateLimit({
    keyPrefix: 'auth:otp-start',
    windowMs: 10 * 60 * 1000,
    max: 5,
    key: bodyFieldKey('phone')
  });
  const otpVerifyLimit = createRateLimit({
    keyPrefix: 'auth:otp-verify',
    windowMs: 5 * 60 * 1000,
    max: 8,
    key: bodyFieldKey('challengeId')
  });
  const emailLoginLimit = createRateLimit({
    keyPrefix: 'auth:email-login',
    windowMs: 10 * 60 * 1000,
    max: 10,
    key: bodyFieldKey('email')
  });
  const emailSignupLimit = createRateLimit({
    keyPrefix: 'auth:email-signup',
    windowMs: 10 * 60 * 1000,
    max: 5,
    key: bodyFieldKey('email')
  });
  const oauthLimit = createRateLimit({ keyPrefix: 'auth:oauth', windowMs: 10 * 60 * 1000, max: 20 });
  const refreshLimit = createRateLimit({ keyPrefix: 'auth:refresh', windowMs: 10 * 60 * 1000, max: 30 });

  app.post('/auth/otp/start', { preHandler: otpStartLimit }, async (request, reply) => {
    const parsed = otpStartSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const result = await auth.startOtp(parsed.data.phone);
      return reply.send(result);
    } catch (error) {
      return reply.status(503).send({ error: (error as Error).message });
    }
  });

  app.post('/auth/otp/verify', { preHandler: otpVerifyLimit }, async (request, reply) => {
    const parsed = otpVerifySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const result = await auth.verifyOtp(parsed.data);
      return reply.send(result);
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.post('/auth/email/signup', { preHandler: emailSignupLimit }, async (request, reply) => {
    const parsed = emailSignupSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const result = await auth.signupEmail(parsed.data);
      return reply.send(result);
    } catch (error) {
      return reply.status(400).send({ error: (error as Error).message });
    }
  });

  app.post('/auth/email/login', { preHandler: emailLoginLimit }, async (request, reply) => {
    const parsed = emailLoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const result = await auth.loginEmail(parsed.data);
      return reply.send(result);
    } catch (error) {
      return reply.status(401).send({ error: (error as Error).message });
    }
  });

  app.post('/auth/oauth/apple', { preHandler: oauthLimit }, async (request, reply) => {
    const parsed = oauthSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const verified = await verifyOAuthIdToken('apple', parsed.data.token);
      const result = await auth.oauthLogin({
        provider: 'apple',
        email: verified.email,
        emailVerified: verified.emailVerified,
        name: verified.name ?? parsed.data.name,
        providerUserId: verified.providerUserId
      });
      return reply.send(result);
    } catch (error) {
      return reply.status(401).send({ error: (error as Error).message });
    }
  });

  app.post('/auth/oauth/google', { preHandler: oauthLimit }, async (request, reply) => {
    const parsed = oauthSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    try {
      const verified = await verifyOAuthIdToken('google', parsed.data.token);
      const result = await auth.oauthLogin({
        provider: 'google',
        email: verified.email,
        emailVerified: verified.emailVerified,
        name: verified.name ?? parsed.data.name,
        providerUserId: verified.providerUserId
      });
      return reply.send(result);
    } catch (error) {
      return reply.status(401).send({ error: (error as Error).message });
    }
  });

  app.post('/auth/session/refresh', { preHandler: refreshLimit }, async (request, reply) => {
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

  app.post('/auth/swiggy/start', { preHandler: requireAuth(auth) }, async (request, reply) => {
    try {
      const result = await swiggy.startAuthorization(request.auth!.user.id);
      return reply.send(result);
    } catch (error) {
      return reply.status(503).send({ error: (error as Error).message });
    }
  });

  app.get('/auth/swiggy/status', { preHandler: requireAuth(auth) }, async (request, reply) => {
    return reply.send(await swiggy.status(request.auth!.user.id));
  });

  app.post('/auth/swiggy/logout', { preHandler: requireAuth(auth) }, async (request, reply) => {
    await swiggy.disconnect(request.auth!.user.id);
    return reply.send({ ok: true });
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
        .send(`<!doctype html><html><body><h1>Swiggy authorization failed</h1><p>${escapeHtml(error)}</p></body></html>`);
    }
    if (!code || !state) {
      return reply
        .status(400)
        .type('text/html; charset=utf-8')
        .send('<!doctype html><html><body><h1>Swiggy authorization failed</h1><p>Missing authorization code or state.</p></body></html>');
    }
    try {
      await swiggy.completeAuthorization({ code, state });
    } catch (completeError) {
      logger.warn('Swiggy OAuth callback completion failed', { error: (completeError as Error).message });
      return reply
        .status(400)
        .type('text/html; charset=utf-8')
        .send(
          `<!doctype html><html><body><h1>Swiggy authorization failed</h1><p>${escapeHtml((completeError as Error).message)}</p></body></html>`
        );
    }
    return reply
      .status(200)
      .type('text/html; charset=utf-8')
      .send('<!doctype html><html><body><h1>Mitr &times; Swiggy</h1><p>Authorization received. You can close this window.</p></body></html>');
  });
};
